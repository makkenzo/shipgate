import { generateKeyPairSync } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  createAes256GcmGitHubTokenCipher,
  createGitHubAuthenticationService,
  GitHubAuthenticationError,
  GitHubInstallationScopeError,
} from '@shipgate/github'
import {
  createInMemoryGitHubUserTokenStore,
  type CreateGitHubClientOptions,
  type GitHubClientFactory,
  type GitHubOAuthClient,
  type GitHubOAuthToken,
} from '@shipgate/github/testing'
import { describe, expect, it, vi } from 'vitest'

const appId = 123_456
const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2_048,
})
  .privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  })
  .toString()

const encryptionKey = Buffer.alloc(32, 11).toString('base64url')
const baseNow = new Date('2026-07-31T20:00:00.000Z')

function createToken(overrides: Partial<GitHubOAuthToken> = {}): GitHubOAuthToken {
  return {
    accessToken: 'user-access-token',
    accessTokenExpiresAt: new Date(baseNow.getTime() + 8 * 60 * 60_000),
    refreshToken: 'user-refresh-token',
    refreshTokenExpiresAt: new Date(baseNow.getTime() + 180 * 24 * 60 * 60_000),
    tokenType: 'bearer',
    ...overrides,
  }
}

describe('GitHub authentication service', () => {
  it('creates and caches repository-scoped installation clients', async () => {
    const created: CreateGitHubClientOptions[] = []
    const installationTokenRequests: unknown[] = []
    let installationTokenSequence = 0

    const clientFactory = createFakeClientFactory(created, async (options, route, input) => {
      if (
        options.authentication.type === 'app' &&
        route === 'POST /app/installations/{installation_id}/access_tokens'
      ) {
        installationTokenRequests.push(input)
        installationTokenSequence += 1

        return {
          data: {
            token: `installation-token-${installationTokenSequence}`,
            expires_at: new Date(baseNow.getTime() + 60 * 60_000).toISOString(),
          },
        }
      }

      return { data: {} }
    })

    const service = createService({ clientFactory })
    const input = {
      installationId: 42,
      repositoryIds: [9, 4, 9],
      permissions: {
        contents: 'read' as const,
      },
    }

    const first = await service.getInstallationClient(input)
    const second = await service.getInstallationClient(input)

    expect(second).toBe(first)
    expect(installationTokenRequests).toEqual([
      {
        installation_id: 42,
        repository_ids: [4, 9],
        permissions: {
          contents: 'read',
        },
      },
    ])
    expect(first.authentication).toEqual({
      type: 'installation',
      installationId: 42,
      repositoryIds: [4, 9],
      permissions: {
        contents: 'read',
      },
    })
    expect(first).not.toHaveProperty('auth')
    expect(first).not.toHaveProperty('token')

    const firstInstallationOptions = created.find(
      (item) => item.authentication.type === 'installation',
    )

    if (!firstInstallationOptions) {
      throw new Error('Expected an installation client to be created')
    }

    await firstInstallationOptions.onUnauthorized()

    const afterUnauthorized = await service.getInstallationClient(input)

    expect(afterUnauthorized).not.toBe(first)
    expect(installationTokenRequests).toHaveLength(2)

    service.invalidateInstallation(42)

    const afterUninstall = await service.getInstallationClient(input)

    expect(afterUninstall).not.toBe(afterUnauthorized)
    expect(installationTokenRequests).toHaveLength(3)
    expect(created.filter((item) => item.authentication.type === 'installation')).toHaveLength(3)
  })

  it('does not resurrect an installation client invalidated during token creation', async () => {
    const tokenRequestStarted = createDeferred<void>()
    const releaseTokenResponse = createDeferred<void>()
    let tokenSequence = 0
    const clientFactory = createFakeClientFactory([], async (options, route) => {
      if (
        options.authentication.type === 'app' &&
        route === 'POST /app/installations/{installation_id}/access_tokens'
      ) {
        tokenSequence += 1

        if (tokenSequence === 1) {
          tokenRequestStarted.resolve()
          await releaseTokenResponse.promise
        }

        return {
          data: {
            token: `installation-token-${tokenSequence}`,
            expires_at: new Date(baseNow.getTime() + 60 * 60_000).toISOString(),
          },
        }
      }

      return { data: {} }
    })
    const service = createService({ clientFactory })
    const input = {
      installationId: 42,
      repositoryIds: [4],
      permissions: {
        metadata: 'read' as const,
      },
    }
    const pending = service.getInstallationClient(input)

    await tokenRequestStarted.promise
    service.invalidateInstallation(42)
    releaseTokenResponse.resolve()

    await expect(pending).rejects.toBeInstanceOf(GitHubAuthenticationError)

    const current = await service.getInstallationClient(input)

    expect(current.authentication.installationId).toBe(42)
    expect(tokenSequence).toBe(2)
  })

  it('defaults installation tokens to metadata:read and rejects excessive permissions', async () => {
    const tokenRequests: unknown[] = []
    const clientFactory = createFakeClientFactory([], async (options, route, input) => {
      if (
        options.authentication.type === 'app' &&
        route === 'POST /app/installations/{installation_id}/access_tokens'
      ) {
        tokenRequests.push(input)

        return {
          data: {
            token: 'installation-token',
            expires_at: new Date(baseNow.getTime() + 60 * 60_000).toISOString(),
          },
        }
      }

      return { data: {} }
    })
    const service = createService({ clientFactory })

    await service.getInstallationClient({
      installationId: 42,
      repositoryIds: [4],
    })

    expect(tokenRequests).toEqual([
      {
        installation_id: 42,
        repository_ids: [4],
        permissions: {
          metadata: 'read',
        },
      },
    ])

    await expect(
      service.getInstallationClient({
        installationId: 42,
        repositoryIds: [4],
        permissions: {
          statuses: 'write',
        },
      }),
    ).rejects.toBeInstanceOf(GitHubInstallationScopeError)

    await expect(
      service.getInstallationClient({
        installationId: 42,
        repositoryIds: [4],
        permissions: {
          constructor: 'read',
        } as never,
      }),
    ).rejects.toBeInstanceOf(GitHubInstallationScopeError)
  })

  it('rotates an expiring user token once across concurrent provider instances', async () => {
    const cipher = createAes256GcmGitHubTokenCipher({ key: encryptionKey })
    const store = createInMemoryGitHubUserTokenStore()
    await store.upsert({
      userId: 7,
      encryptedAccessToken: cipher.encrypt({
        userId: 7,
        purpose: 'access',
        token: 'old-access-token',
      }),
      accessTokenExpiresAt: new Date(baseNow.getTime() + 1_000),
      encryptedRefreshToken: cipher.encrypt({
        userId: 7,
        purpose: 'refresh',
        token: 'old-refresh-token',
      }),
      refreshTokenExpiresAt: new Date(baseNow.getTime() + 30 * 24 * 60 * 60_000),
    })

    const refreshedToken = createToken({
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
    })
    const refreshUserToken = vi.fn(async (refreshToken: string) => {
      expect(refreshToken).toBe('old-refresh-token')
      await delay(20)
      return refreshedToken
    })
    const oauthClient: GitHubOAuthClient = {
      exchangeAuthorizationCode: vi.fn(),
      refreshUserToken,
    }
    const created: CreateGitHubClientOptions[] = []
    const clientFactory = createFakeClientFactory(created)
    const firstService = createService({ cipher, store, oauthClient, clientFactory })
    const secondService = createService({ cipher, store, oauthClient, clientFactory })

    const [first, second] = await Promise.all([
      firstService.getUserClient(7),
      secondService.getUserClient(7),
    ])

    expect(first.authentication).toEqual({ type: 'user', userId: 7 })
    expect(second.authentication).toEqual({ type: 'user', userId: 7 })
    expect(refreshUserToken).toHaveBeenCalledTimes(1)
    expect(
      created.filter(
        (item) => item.authentication.type === 'user' && item.auth === 'rotated-access-token',
      ),
    ).toHaveLength(2)

    const stored = await store.get(7)

    expect(stored?.version).toBe(2)

    if (!stored) {
      throw new Error('Expected rotated credentials to be stored')
    }

    expect(stored.encryptedAccessToken).not.toContain('rotated-access-token')
    expect(
      cipher.decrypt({
        userId: 7,
        purpose: 'access',
        encryptedToken: stored.encryptedAccessToken,
      }),
    ).toBe('rotated-access-token')
    expect(
      cipher.decrypt({
        userId: 7,
        purpose: 'refresh',
        encryptedToken: stored.encryptedRefreshToken,
      }),
    ).toBe('rotated-refresh-token')
  })

  it('refreshes a user credential after a client receives 401', async () => {
    const cipher = createAes256GcmGitHubTokenCipher({ key: encryptionKey })
    const store = createInMemoryGitHubUserTokenStore()
    await store.upsert({
      userId: 8,
      encryptedAccessToken: cipher.encrypt({
        userId: 8,
        purpose: 'access',
        token: 'current-access-token',
      }),
      accessTokenExpiresAt: new Date(baseNow.getTime() + 60 * 60_000),
      encryptedRefreshToken: cipher.encrypt({
        userId: 8,
        purpose: 'refresh',
        token: 'current-refresh-token',
      }),
      refreshTokenExpiresAt: new Date(baseNow.getTime() + 30 * 24 * 60 * 60_000),
    })

    const refreshUserToken = vi.fn(async () =>
      createToken({
        accessToken: 'refreshed-after-401',
        refreshToken: 'refresh-after-401',
      }),
    )
    const oauthClient: GitHubOAuthClient = {
      exchangeAuthorizationCode: vi.fn(),
      refreshUserToken,
    }
    const created: CreateGitHubClientOptions[] = []
    const service = createService({
      cipher,
      store,
      oauthClient,
      clientFactory: createFakeClientFactory(created),
    })

    const first = await service.getUserClient(8)
    const firstOptions = created.find(
      (item) => item.authentication.type === 'user' && item.authentication.userId === 8,
    )

    if (!firstOptions) {
      throw new Error('Expected a user client to be created')
    }

    await firstOptions.onUnauthorized()

    const second = await service.getUserClient(8)

    expect(second).not.toBe(first)
    expect(refreshUserToken).toHaveBeenCalledOnce()
    expect(
      created.some(
        (item) => item.authentication.type === 'user' && item.auth === 'refreshed-after-401',
      ),
    ).toBe(true)
  })

  it('does not resurrect a user client invalidated while credentials are loading', async () => {
    const cipher = createAes256GcmGitHubTokenCipher({ key: encryptionKey })
    const underlyingStore = createInMemoryGitHubUserTokenStore()
    await underlyingStore.upsert({
      userId: 9,
      encryptedAccessToken: cipher.encrypt({
        userId: 9,
        purpose: 'access',
        token: 'user-access-token',
      }),
      accessTokenExpiresAt: new Date(baseNow.getTime() + 60 * 60_000),
      encryptedRefreshToken: cipher.encrypt({
        userId: 9,
        purpose: 'refresh',
        token: 'user-refresh-token',
      }),
      refreshTokenExpiresAt: new Date(baseNow.getTime() + 30 * 24 * 60 * 60_000),
    })

    const credentialReadStarted = createDeferred<void>()
    const releaseCredentialRead = createDeferred<void>()
    let delayed = true
    const store: typeof underlyingStore = {
      ...underlyingStore,
      async get(userId) {
        const snapshot = await underlyingStore.get(userId)

        if (delayed) {
          delayed = false
          credentialReadStarted.resolve()
          await releaseCredentialRead.promise
        }

        return snapshot
      },
    }
    const service = createService({ cipher, store })
    const pending = service.getUserClient(9)

    await credentialReadStarted.promise
    await service.revokeUser(9)
    releaseCredentialRead.resolve()

    await expect(pending).rejects.toBeInstanceOf(GitHubAuthenticationError)
    await expect(service.getUserClient(9)).rejects.toMatchObject({
      name: 'GitHubUserAuthorizationNotFoundError',
      userId: 9,
    })
  })

  it('stores authorization-code tokens encrypted and clears revoked users', async () => {
    const cipher = createAes256GcmGitHubTokenCipher({ key: encryptionKey })
    const store = createInMemoryGitHubUserTokenStore()
    const token = createToken()
    const oauthClient: GitHubOAuthClient = {
      exchangeAuthorizationCode: vi.fn(async () => token),
      refreshUserToken: vi.fn(),
    }
    const clientFactory = createFakeClientFactory([], async (options, route) => {
      if (options.authentication.type === 'user' && route === 'GET /user') {
        return { data: { id: 99 } }
      }

      return { data: {} }
    })
    const service = createService({ cipher, store, oauthClient, clientFactory })

    const authorization = await service.authorizeUser({
      code: 'authorization-code',
      expectedUserId: 99,
    })

    expect(authorization.userId).toBe(99)

    const stored = await store.get(99)

    expect(stored).toBeDefined()
    expect(stored?.encryptedAccessToken).not.toContain(token.accessToken)
    expect(stored?.encryptedRefreshToken).not.toContain(token.refreshToken)

    await service.revokeUser(99)

    expect(await store.get(99)).toBeUndefined()
    await expect(service.getUserClient(99)).rejects.toMatchObject({
      name: 'GitHubUserAuthorizationNotFoundError',
      userId: 99,
    })
  })
})

function createDeferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return {
    promise,
    resolve,
    reject,
  }
}

function createService(
  overrides: {
    readonly cipher?: ReturnType<typeof createAes256GcmGitHubTokenCipher>
    readonly store?: ReturnType<typeof createInMemoryGitHubUserTokenStore>
    readonly oauthClient?: GitHubOAuthClient
    readonly clientFactory?: GitHubClientFactory
  } = {},
) {
  return createGitHubAuthenticationService({
    appId,
    clientId: 'Iv1.shipgate',
    clientSecret: 'client-secret',
    privateKey,
    apiBaseUrl: 'https://api.github.com',
    oauthBaseUrl: 'https://github.com',
    apiVersion: '2026-03-10',
    requestTimeoutMs: 10,
    userAgent: 'shipgate/test',
    tokenCipher: overrides.cipher ?? createAes256GcmGitHubTokenCipher({ key: encryptionKey }),
    userTokenStore: overrides.store ?? createInMemoryGitHubUserTokenStore(),
    tokenEarlyRefreshMs: 5_000,
    refreshLeaseMs: 100,
    refreshLeasePollMs: 1,
    now: () => new Date(baseNow),
    ...(overrides.oauthClient !== undefined ? { oauthClient: overrides.oauthClient } : {}),
    ...(overrides.clientFactory !== undefined ? { clientFactory: overrides.clientFactory } : {}),
  })
}

function createFakeClientFactory(
  created: CreateGitHubClientOptions[],
  requestHandler: (
    options: CreateGitHubClientOptions,
    route: string,
    input: unknown,
  ) => Promise<unknown> = async () => ({ data: {} }),
): GitHubClientFactory {
  return ((options: CreateGitHubClientOptions) => {
    created.push(options)

    return Object.freeze({
      authentication: options.authentication,
      request: (route: string, input?: unknown) => requestHandler(options, route, input),
      graphql: vi.fn(),
    })
  }) as unknown as GitHubClientFactory
}
