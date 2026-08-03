import { createHash } from 'node:crypto'

import { migrateToLatest } from '@shipgate/database'
import type {
  AppGitHubClient,
  GitHubAuthenticationService,
  GitHubResponse,
  InstallationGitHubClient,
  UserGitHubClient,
} from '@shipgate/github'
import {
  createTestEnvironment,
  type PostgresTestDatabase,
  startPostgresTestDatabase,
} from '@shipgate/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { type ApplicationContext, createApplicationContext } from '../src/application-context.js'
import { createGitHubRepositoryAccessService } from '../src/github-access/index.js'
import { buildApiApplication } from '../src/http/api-app.js'

describe.sequential('GitHub login and Shipgate sessions', () => {
  let postgres: PostgresTestDatabase
  let baseContext: ApplicationContext
  let context: ApplicationContext
  let app: FastifyInstance
  const authorizeUser = vi.fn()
  const disconnectUser = vi.fn()

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    baseContext = createApplicationContext({
      processKind: 'api',
      environment: createTestEnvironment(postgres.connectionString, {
        APP_ORIGIN: 'https://shipgate.example',
        GITHUB_APP_ID: '123456',
        GITHUB_APP_CLIENT_ID: 'Iv1.shipgate',
        AUTH_SESSION_TTL_SECONDS: '3600',
        AUTH_OAUTH_ATTEMPT_TTL_SECONDS: '300',
      }),
    })

    await migrateToLatest(baseContext.database.kysely)

    const githubAuth = createFakeGitHubAuthentication(baseContext, {
      authorizeUser,
      disconnectUser,
    })

    context = {
      ...baseContext,
      githubAuth,
      githubRepositoryAccess: createGitHubRepositoryAccessService({
        database: baseContext.database,
        githubAuth,
      }),
    }

    app = await buildApiApplication(context)
    await app.ready()
  }, 60_000)

  afterAll(async () => {
    await app.close()
    await baseContext.database.destroy()
    await postgres.stop()
  })

  it('turns a GitHub post-installation redirect into a stateful OAuth flow', async () => {
    const setup = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/callback?installation_id=123&setup_action=install',
    })

    expect(setup.statusCode).toBe(302)

    const loginUrl = new URL(requireHeader(setup.headers.location, 'location'))

    expect(loginUrl.pathname).toBe('/api/v1/auth/github')
    expect(loginUrl.searchParams.get('returnTo')).toBe(
      '/setup?installation_action=install&installation_id=123',
    )

    const started = await app.inject({
      method: 'GET',
      url: `${loginUrl.pathname}${loginUrl.search}`,
    })

    expect(started.statusCode).toBe(302)

    const authorizeUrl = new URL(requireHeader(started.headers.location, 'location'))

    expect(authorizeUrl.pathname).toBe('/login/oauth/authorize')
    expect(authorizeUrl.searchParams.get('state')).toBeTruthy()
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy()
  })

  it('rejects OAuth state that was not issued or has expired', async () => {
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/callback?code=authorization-code&state=not-issued',
    })

    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ code: 'INVALID_OAUTH_STATE' })

    const started = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github',
    })
    const authorizeUrl = new URL(requireHeader(started.headers.location, 'location'))
    const state = requireValue(authorizeUrl.searchParams.get('state'), 'state')
    const stateHash = createHash('sha256').update(state, 'utf8').digest('hex')

    await context.database.kysely
      .updateTable('oauth_attempts')
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where('state_hash', '=', stateHash)
      .execute()

    const expired = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
    })

    expect(expired.statusCode).toBe(400)
    expect(expired.json()).toMatchObject({ code: 'INVALID_OAUTH_STATE' })
  })

  it('uses one-time state and PKCE, persists the session, and enforces CSRF', async () => {
    const started = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github?returnTo=%2Freleases%3Fproject%3D42',
    })

    expect(started.statusCode).toBe(302)

    const authorizeUrl = new URL(requireHeader(started.headers.location, 'location'))
    const state = authorizeUrl.searchParams.get('state')
    const challenge = authorizeUrl.searchParams.get('code_challenge')

    expect(authorizeUrl.pathname).toBe('/login/oauth/authorize')
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(state).toBeTruthy()
    expect(challenge).toBeTruthy()

    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=authorization-code&state=${encodeURIComponent(
        requireValue(state, 'state'),
      )}`,
    })

    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toContain('/releases?project=42&auth=succeeded')
    expect(authorizeUser).toHaveBeenCalledOnce()

    const authorizationInput = authorizeUser.mock.calls[0]?.[0] as
      | { readonly codeVerifier?: string }
      | undefined
    const verifier = requireValue(authorizationInput?.codeVerifier, 'code verifier')

    expect(createHash('sha256').update(verifier, 'ascii').digest('base64url')).toBe(challenge)

    const cookies = readSetCookies(callback.headers['set-cookie'])
    const cookieHeader = toCookieHeader(cookies)
    const csrfToken = readCookie(cookies, '__Host-shipgate_csrf')

    expect(readCookie(cookies, '__Host-shipgate_session')).toBeTruthy()
    expect(cookies.join('\n')).toContain('HttpOnly')
    expect(cookies.join('\n')).toContain('Secure')
    expect(cookies.join('\n')).toContain('SameSite=Lax')

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: {
        cookie: cookieHeader,
      },
    })

    expect(session.statusCode).toBe(200)
    expect(session.headers['cache-control']).toBe('no-store')
    expect(session.json()).toMatchObject({
      authenticated: true,
      user: {
        id: 99,
        login: 'octocat',
        installations: [
          {
            id: 123,
            account: {
              id: 99,
              login: 'octocat',
            },
          },
        ],
      },
    })

    await app.close()
    app = await buildApiApplication(context)
    await app.ready()

    const afterRestart = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: {
        cookie: cookieHeader,
      },
    })

    expect(afterRestart.json()).toMatchObject({ authenticated: true })

    const rejectedLogout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
      },
      payload: {},
    })

    expect(rejectedLogout.statusCode).toBe(403)
    expect(rejectedLogout.json()).toMatchObject({
      code: 'CSRF_VALIDATION_FAILED',
    })

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      payload: {},
    })

    expect(logout.statusCode).toBe(204)

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: {
        cookie: cookieHeader,
      },
    })

    expect(afterLogout.json()).toEqual({ authenticated: false })

    const reusedState = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=second-code&state=${encodeURIComponent(
        requireValue(state, 'state'),
      )}`,
    })

    expect(reusedState.statusCode).toBe(400)
    expect(reusedState.json()).toMatchObject({ code: 'INVALID_OAUTH_STATE' })
  })

  it('disconnects the GitHub grant and revokes every session through credential cascade', async () => {
    const first = await login(app)
    const second = await login(app)

    const disconnect = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/disconnect',
      headers: {
        cookie: first.cookieHeader,
        'content-type': 'application/json',
        'x-csrf-token': first.csrfToken,
      },
      payload: {},
    })

    expect(disconnect.statusCode).toBe(204)
    expect(disconnectUser).toHaveBeenCalledWith(99)

    for (const cookieHeader of [first.cookieHeader, second.cookieHeader]) {
      const session = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        headers: {
          cookie: cookieHeader,
        },
      })

      expect(session.json()).toEqual({ authenticated: false })
    }
  })
})

function createFakeGitHubAuthentication(
  context: ApplicationContext,
  spies: {
    readonly authorizeUser: (
      input: Parameters<GitHubAuthenticationService['authorizeUser']>[0],
    ) => void
    readonly disconnectUser: (userId: number) => void
  },
): GitHubAuthenticationService {
  const userClient = {
    authentication: {
      type: 'user' as const,
      userId: 99,
    },
    async request<Data = unknown>(route: string): Promise<GitHubResponse<Data>> {
      if (route === 'GET /user') {
        return createGitHubResponse<Data>({
          id: 99,
          login: 'octocat',
          avatar_url: 'https://avatars.example/octocat.png',
          name: 'The Octocat',
          email: null,
          html_url: 'https://github.com/octocat',
        })
      }

      if (route === 'GET /user/installations') {
        return createGitHubResponse<Data>({
          total_count: 1,
          installations: [
            {
              id: 123,
              account: {
                id: 99,
                login: 'octocat',
                type: 'User',
                avatar_url: 'https://avatars.example/octocat.png',
              },
              repository_selection: 'selected',
              permissions: {
                metadata: 'read',
                contents: 'write',
              },
              suspended_at: null,
            },
          ],
        })
      }

      if (route === 'GET /user/installations/{installation_id}/repositories') {
        return createGitHubResponse<Data>({
          total_count: 1,
          repositories: [createRepository({ pull: true, push: true })],
        })
      }

      return createGitHubResponse<Data>({})
    },
    async graphql<Data = unknown>() {
      return {} as Data
    },
  } satisfies UserGitHubClient
  const appClient = {
    authentication: {
      type: 'app' as const,
      appId: 123_456,
    },
    async request<Data = unknown>(route: string): Promise<GitHubResponse<Data>> {
      if (route === 'GET /app/installations/{installation_id}') {
        return createGitHubResponse<Data>({
          id: 123,
          account: {
            id: 99,
            login: 'octocat',
            type: 'User',
            avatar_url: 'https://avatars.example/octocat.png',
          },
          target_type: 'User',
          repository_selection: 'selected',
          permissions: {
            metadata: 'read',
            contents: 'write',
          },
          suspended_at: null,
        })
      }

      return createGitHubResponse<Data>({})
    },
    async graphql<Data = unknown>() {
      return {} as Data
    },
  } satisfies AppGitHubClient
  const installationClient = {
    authentication: {
      type: 'installation' as const,
      installationId: 123,
      repositoryIds: undefined,
      permissions: {
        metadata: 'read' as const,
      },
    },
    async request<Data = unknown>(route: string): Promise<GitHubResponse<Data>> {
      if (route === 'GET /installation/repositories') {
        return createGitHubResponse<Data>({
          total_count: 1,
          repositories: [createRepository({ pull: true, push: true })],
        })
      }

      return createGitHubResponse<Data>({})
    },
    async graphql<Data = unknown>() {
      return {} as Data
    },
  } satisfies InstallationGitHubClient

  return {
    async getAppClient() {
      return appClient
    },
    async getInstallationClient() {
      return installationClient
    },
    async getUserClient() {
      return userClient
    },
    async authorizeUser(input) {
      spies.authorizeUser(input)

      await context.database.kysely
        .insertInto('github_user_credentials')
        .values({
          github_user_id: '99',
          encrypted_access_token: 'encrypted-access-token',
          access_token_expires_at: new Date(Date.now() + 60 * 60_000),
          encrypted_refresh_token: 'encrypted-refresh-token',
          refresh_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000),
          refresh_lease_id: null,
          refresh_lease_expires_at: null,
        })
        .onConflict((conflict) =>
          conflict.column('github_user_id').doUpdateSet({
            encrypted_access_token: 'encrypted-access-token',
            access_token_expires_at: new Date(Date.now() + 60 * 60_000),
            encrypted_refresh_token: 'encrypted-refresh-token',
            refresh_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000),
            refresh_lease_id: null,
            refresh_lease_expires_at: null,
          }),
        )
        .execute()

      return {
        userId: 99,
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000),
        refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      }
    },
    invalidateInstallation() {},
    invalidateUser() {},
    async revokeUser(userId) {
      await context.database.kysely
        .deleteFrom('github_user_credentials')
        .where('github_user_id', '=', String(userId))
        .execute()
    },
    async disconnectUser(userId) {
      spies.disconnectUser(userId)
      await context.database.kysely
        .deleteFrom('github_user_credentials')
        .where('github_user_id', '=', String(userId))
        .execute()
    },
  }
}

async function login(app: FastifyInstance): Promise<{
  readonly cookieHeader: string
  readonly csrfToken: string
}> {
  const started = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/github',
  })
  const authorizeUrl = new URL(requireHeader(started.headers.location, 'location'))
  const state = requireValue(authorizeUrl.searchParams.get('state'), 'state')
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/github/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
  })
  const cookies = readSetCookies(callback.headers['set-cookie'])

  return {
    cookieHeader: toCookieHeader(cookies),
    csrfToken: readCookie(cookies, '__Host-shipgate_csrf'),
  }
}

function createRepository(permissions: Readonly<Record<string, boolean>>) {
  return {
    id: 456,
    name: 'shipgate',
    full_name: 'octocat/shipgate',
    private: true,
    archived: false,
    disabled: false,
    default_branch: 'main',
    visibility: 'private',
    owner: {
      id: 99,
      login: 'octocat',
    },
    permissions,
  }
}

function createGitHubResponse<Data>(data: unknown): GitHubResponse<Data> {
  return {
    data: data as Data,
    status: 200,
    headers: {},
    url: 'https://api.github.com/test',
  }
}

function readSetCookies(value: string | string[] | undefined): readonly string[] {
  if (!value) {
    throw new Error('Expected set-cookie response headers')
  }

  return Array.isArray(value) ? value : [value]
}

function toCookieHeader(cookies: readonly string[]): string {
  return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ')
}

function readCookie(cookies: readonly string[], name: string): string {
  const prefix = `${name}=`
  const cookie = cookies.find((candidate) => candidate.startsWith(prefix))

  if (!cookie) {
    throw new Error(`Expected ${name} cookie`)
  }

  return decodeURIComponent(cookie.slice(prefix.length).split(';', 1)[0] ?? '')
}

function requireHeader(value: string | string[] | undefined, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${name} response header`)
  }

  return value
}

function requireValue<Value>(value: Value | null | undefined, name: string): Value {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${name}`)
  }

  return value
}
