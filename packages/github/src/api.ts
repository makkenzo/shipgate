export type GitHubPermissionLevel = 'read' | 'write'

export interface AuthenticatedGitHubApp {
  readonly id: number
  readonly slug: string | undefined
  readonly clientId: string | undefined
  readonly permissions: Readonly<Record<string, GitHubPermissionLevel>>
  readonly events: readonly string[]
}

export interface GitHubAppWebhookConfig {
  readonly contentType: string | undefined
  readonly insecureSsl: string | number | undefined
  readonly secret: string | undefined
  readonly url: string | undefined
}

export class GitHubApiRequestError extends Error {
  readonly path: string
  readonly status: number | undefined
  readonly requestId: string | undefined
  readonly responseMessage: string | undefined

  constructor(
    message: string,
    options: {
      readonly path: string
      readonly status?: number
      readonly requestId?: string
      readonly responseMessage?: string
      readonly cause?: unknown
    },
  ) {
    super(message, {
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })

    this.name = 'GitHubApiRequestError'
    this.path = options.path
    this.status = options.status
    this.requestId = options.requestId
    this.responseMessage = options.responseMessage
  }
}

export interface GitHubAppApiClientOptions {
  readonly apiBaseUrl: string
  readonly apiVersion: string
  readonly jwt: string
  readonly requestTimeoutMs: number
  readonly fetchImplementation?: typeof fetch
}

export interface GitHubAppApiClient {
  getAuthenticatedApp(): Promise<AuthenticatedGitHubApp>
  getWebhookConfig(): Promise<GitHubAppWebhookConfig>
}

export function createGitHubAppApiClient(options: GitHubAppApiClientOptions): GitHubAppApiClient {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch

  const request = async (path: string): Promise<unknown> => {
    let response: Response

    try {
      response = await fetchImplementation(new URL(path, options.apiBaseUrl), {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${options.jwt}`,
          'x-github-api-version': options.apiVersion,
          'user-agent': 'shipgate-github-app-validator',
        },
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      })
    } catch (cause) {
      throw new GitHubApiRequestError(`Unable to reach GitHub API endpoint ${path}`, {
        path,
        cause,
      })
    }

    const responseText = await response.text()
    const responseBody = parseResponseBody(responseText)
    const responseMessage = getStringProperty(responseBody, 'message')
    const requestId = response.headers.get('x-github-request-id') ?? undefined

    if (!response.ok) {
      const responseSummary = responseMessage
        ? `${response.status}: ${responseMessage}`
        : String(response.status)

      throw new GitHubApiRequestError(`GitHub API ${path} returned ${responseSummary}`, {
        path,
        status: response.status,
        ...(requestId !== undefined ? { requestId } : {}),
        ...(responseMessage !== undefined ? { responseMessage } : {}),
      })
    }

    return responseBody
  }

  return {
    async getAuthenticatedApp() {
      return parseAuthenticatedApp(await request('/app'))
    },

    async getWebhookConfig() {
      return parseWebhookConfig(await request('/app/hook/config'))
    },
  }
}

function parseAuthenticatedApp(value: unknown): AuthenticatedGitHubApp {
  if (!isRecord(value) || typeof value.id !== 'number') {
    throw new GitHubApiRequestError('GitHub API /app returned an invalid response body', {
      path: '/app',
    })
  }

  const permissions = value.permissions
  const events = value.events

  if (!isRecord(permissions) || !Array.isArray(events) || !events.every(isString)) {
    throw new GitHubApiRequestError('GitHub API /app response is missing permissions or events', {
      path: '/app',
    })
  }

  const parsedPermissions: Record<string, GitHubPermissionLevel> = {}

  for (const [permission, level] of Object.entries(permissions)) {
    if (level !== 'read' && level !== 'write') {
      throw new GitHubApiRequestError(
        `GitHub API /app returned an unsupported permission level for ${permission}`,
        {
          path: '/app',
        },
      )
    }

    parsedPermissions[permission] = level
  }

  return {
    id: value.id,
    slug: getStringProperty(value, 'slug'),
    clientId: getStringProperty(value, 'client_id'),
    permissions: parsedPermissions,
    events,
  }
}

function parseWebhookConfig(value: unknown): GitHubAppWebhookConfig {
  if (!isRecord(value)) {
    throw new GitHubApiRequestError(
      'GitHub API /app/hook/config returned an invalid response body',
      {
        path: '/app/hook/config',
      },
    )
  }

  const insecureSsl = value.insecure_ssl

  if (
    insecureSsl !== undefined &&
    typeof insecureSsl !== 'string' &&
    typeof insecureSsl !== 'number'
  ) {
    throw new GitHubApiRequestError(
      'GitHub API /app/hook/config returned an invalid insecure_ssl value',
      {
        path: '/app/hook/config',
      },
    )
  }

  return {
    contentType: getStringProperty(value, 'content_type'),
    insecureSsl,
    secret: getStringProperty(value, 'secret'),
    url: getStringProperty(value, 'url'),
  }
}

function parseResponseBody(value: string): unknown {
  if (value.length === 0) {
    return undefined
  }

  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const property = value[key]

  return typeof property === 'string' ? property : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}
