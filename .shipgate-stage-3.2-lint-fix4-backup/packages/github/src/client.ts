import { Octokit } from '@octokit/core'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'

import { GitHubAuthenticationError } from './errors.js'

const ShipgateOctokit = Octokit.plugin(retry, throttling)

type ShipgateOctokitInstance = InstanceType<typeof ShipgateOctokit>

export interface GitHubResponse<Data = unknown> {
  readonly data: Data
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly url: string
}

export interface GitHubRequest {
  <Data = unknown>(
    route: string,
    parameters?: Readonly<Record<string, unknown>>,
  ): Promise<GitHubResponse<Data>>
}

export interface GitHubGraphql {
  <Data = unknown>(query: string, parameters?: Readonly<Record<string, unknown>>): Promise<Data>
}

export interface GitHubClient {
  readonly request: GitHubRequest
  readonly graphql: GitHubGraphql
}

export interface AppGitHubClient extends GitHubClient {
  readonly authentication: {
    readonly type: 'app'
    readonly appId: number
  }
}

export interface InstallationGitHubClient extends GitHubClient {
  readonly authentication: {
    readonly type: 'installation'
    readonly installationId: number
    readonly repositoryIds: readonly number[] | undefined
    readonly permissions: InstallationPermissions
  }
}

export interface UserGitHubClient extends GitHubClient {
  readonly authentication: {
    readonly type: 'user'
    readonly userId: number
  }
}

export type InstallationPermissionName =
  | 'metadata'
  | 'contents'
  | 'pull_requests'
  | 'checks'
  | 'statuses'
  | 'administration'
  | 'workflows'

export type InstallationPermissionLevel = 'read' | 'write'

export type InstallationPermissions = Partial<
  Readonly<Record<InstallationPermissionName, InstallationPermissionLevel>>
>

export interface GitHubClientLogger {
  debug(message: string, additionalInfo?: unknown): void
  info(message: string, additionalInfo?: unknown): void
  warn(message: string, additionalInfo?: unknown): void
  error(message: string, additionalInfo?: unknown): void
}

export type GitHubClientAuthentication =
  | AppGitHubClient['authentication']
  | InstallationGitHubClient['authentication']
  | UserGitHubClient['authentication']

export interface CreateGitHubClientOptions {
  readonly auth: string
  readonly authentication: GitHubClientAuthentication
  readonly apiBaseUrl: string
  readonly apiVersion: string
  readonly requestTimeoutMs: number
  readonly userAgent: string
  readonly logger?: GitHubClientLogger
  readonly fetchImplementation?: typeof fetch
  readonly onUnauthorized: () => Promise<void> | void
}

export type GitHubClientFactory = (
  options: CreateGitHubClientOptions,
) => AppGitHubClient | InstallationGitHubClient | UserGitHubClient

export const createGitHubClient: GitHubClientFactory = (options) => {
  const octokit = new ShipgateOctokit({
    auth: options.auth,
    baseUrl: options.apiBaseUrl,
    userAgent: options.userAgent,
    request: {
      timeout: options.requestTimeoutMs,
      retries: 0,
      ...(options.fetchImplementation !== undefined
        ? {
            fetch: options.fetchImplementation,
          }
        : {}),
    },
    throttle: {
      onRateLimit(
        retryAfter: number,
        requestOptions: { readonly method: string; readonly url: string },
        octokitClient: { readonly log: { warn(message: string): void } },
        _retryCount: number,
      ) {
        octokitClient.log.warn(
          [
            'GitHub primary rate limit reached for',
            `${requestOptions.method} ${requestOptions.url};`,
            `retry after ${retryAfter}s`,
          ].join(' '),
        )

        return false
      },

      onSecondaryRateLimit(
        retryAfter: number,
        requestOptions: { readonly method: string; readonly url: string },
        octokitClient: { readonly log: { warn(message: string): void } },
        _retryCount: number,
      ) {
        octokitClient.log.warn(
          [
            'GitHub secondary rate limit reached for',
            `${requestOptions.method} ${requestOptions.url};`,
            `retry after ${retryAfter}s`,
          ].join(' '),
        )

        return false
      },
    },
    ...(options.logger !== undefined
      ? {
          log: options.logger,
        }
      : {}),
  })

  octokit.hook.error('request', async (error) => {
    if (getStatus(error) === 401) {
      await options.onUnauthorized()
    }

    throw error
  })

  const client = {
    request: createSafeRequest(octokit, options.apiBaseUrl, options.apiVersion),
    graphql: createSafeGraphql(octokit, options.apiBaseUrl),
    authentication: Object.freeze(options.authentication),
  }

  return Object.freeze(client) as ReturnType<GitHubClientFactory>
}

function createSafeGraphql(octokit: ShipgateOctokitInstance, apiBaseUrl: string): GitHubGraphql {
  return ((query: string, parameters?: Readonly<Record<string, unknown>>) => {
    return octokit.graphql(query, {
      ...getCallerParameters(parameters),
      baseUrl: apiBaseUrl,
      headers: getCallerHeaders(parameters?.headers),
      request: {
        ...getCallerRequestOptions(parameters?.request),
        retries: 0,
      },
    })
  }) as GitHubGraphql
}

function createSafeRequest(
  octokit: ShipgateOctokitInstance,
  apiBaseUrl: string,
  apiVersion: string,
): GitHubRequest {
  return ((route: string, parameters?: Readonly<Record<string, unknown>>) => {
    const prepared = prepareGitHubRestRequest({
      route,
      apiBaseUrl,
      apiVersion,
      ...(parameters !== undefined ? { parameters } : {}),
    })

    return octokit.request(prepared.route, prepared.parameters)
  }) as GitHubRequest
}

export function prepareGitHubRestRequest(input: {
  readonly route: string
  readonly parameters?: Readonly<Record<string, unknown>>
  readonly apiBaseUrl: string
  readonly apiVersion: string
}): {
  readonly route: string
  readonly parameters: Readonly<Record<string, unknown>>
} {
  const { method, path } = parseRoute(input.route)
  const retries = method === 'GET' || method === 'HEAD' ? 2 : 0

  return {
    route: input.route,
    parameters: {
      ...getCallerParameters(input.parameters),
      method,
      url: path,
      baseUrl: input.apiBaseUrl,
      headers: {
        ...getCallerHeaders(input.parameters?.headers),
        accept: 'application/vnd.github+json',
        'x-github-api-version': input.apiVersion,
      },
      request: {
        ...getCallerRequestOptions(input.parameters?.request),
        retries,
      },
    },
  }
}

function parseRoute(route: string): {
  readonly method: string
  readonly path: string
} {
  const match = /^([A-Z]+) (\/(?:[^\s]*))$/.exec(route)

  if (!match?.[1] || !match[2] || match[2].startsWith('//') || match[2].includes('\\')) {
    throw new GitHubAuthenticationError(
      'GitHub client requests must use an explicit METHOD /path route on the configured API origin',
    )
  }

  return {
    method: match[1],
    path: match[2],
  }
}

function getCallerParameters(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    return {}
  }

  const reserved = new Set(['auth', 'baseUrl', 'headers', 'method', 'request', 'url'])

  return Object.fromEntries(Object.entries(value).filter(([name]) => !reserved.has(name)))
}

function getCallerHeaders(value: unknown): Readonly<Record<string, string | number | undefined>> {
  if (!isRecord(value)) {
    return {}
  }

  const reserved = new Set([
    'accept',
    'authorization',
    'host',
    'user-agent',
    'x-github-api-version',
  ])
  const headers: Record<string, string | number | undefined> = {}

  for (const [name, headerValue] of Object.entries(value)) {
    if (reserved.has(name.toLowerCase())) {
      continue
    }

    if (
      typeof headerValue === 'string' ||
      typeof headerValue === 'number' ||
      headerValue === undefined
    ) {
      headers[name] = headerValue
    }
  }

  return headers
}

function getCallerRequestOptions(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !('signal' in value)) {
    return {}
  }

  return {
    signal: value.signal,
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function getStatus(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    return undefined
  }

  const status = Reflect.get(value, 'status')

  return typeof status === 'number' ? status : undefined
}
