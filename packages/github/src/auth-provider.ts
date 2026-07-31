import { randomUUID, type KeyObject } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  type AppGitHubClient,
  createGitHubClient,
  type GitHubClientFactory,
  type GitHubClientLogger,
  type InstallationGitHubClient,
  type InstallationPermissionLevel,
  type InstallationPermissionName,
  type InstallationPermissions,
  type UserGitHubClient,
} from './client.js'
import {
  GitHubAuthenticationError,
  GitHubInstallationScopeError,
  GitHubUserAuthorizationNotFoundError,
  GitHubUserReauthorizationRequiredError,
  GitHubUserTokenRotationError,
} from './errors.js'
import { createGitHubAppJwtCredential, loadGitHubAppPrivateKey } from './jwt.js'
import {
  createGitHubOAuthClient,
  type GitHubOAuthClient,
  GitHubOAuthRequestError,
  type GitHubOAuthToken,
} from './oauth.js'
import { GITHUB_APP_REPOSITORY_PERMISSIONS } from './registration.js'
import type { GitHubTokenCipher } from './token-cipher.js'
import type {
  GitHubUserTokenStore,
  StoredGitHubUserCredentialInput,
  StoredGitHubUserCredentials,
} from './user-token-store.js'

const appJwtEarlyRefreshMs = 60_000
const defaultTokenEarlyRefreshMs = 5 * 60_000
const defaultRefreshLeaseMs = 60_000
const defaultRefreshLeasePollMs = 100
const maximumInstallationRepositoryCount = 500

const defaultInstallationPermissions: InstallationPermissions = Object.freeze({
  metadata: 'read',
})

export interface GitHubAuthProvider {
  getAppClient(): Promise<AppGitHubClient>

  getInstallationClient(input: {
    installationId: number
    repositoryIds?: number[]
    permissions?: InstallationPermissions
  }): Promise<InstallationGitHubClient>

  getUserClient(userId: number): Promise<UserGitHubClient>
}

export interface GitHubAuthInvalidator {
  invalidateInstallation(installationId: number): void
  invalidateUser(userId: number): void
  revokeUser(userId: number): Promise<void>
}

export interface GitHubUserAuthorizationService {
  authorizeUser(input: {
    readonly code: string
    readonly redirectUri?: string
    readonly expectedUserId?: number
  }): Promise<GitHubUserAuthorizationResult>
}

export interface GitHubAuthenticationService
  extends GitHubAuthProvider,
    GitHubAuthInvalidator,
    GitHubUserAuthorizationService {}

export interface GitHubUserAuthorizationResult {
  readonly userId: number
  readonly accessTokenExpiresAt: Date
  readonly refreshTokenExpiresAt: Date
}

export interface CreateGitHubAuthenticationServiceOptions {
  readonly appId: number
  readonly clientId: string
  readonly clientSecret: string
  readonly privateKey: string | KeyObject
  readonly apiBaseUrl: string
  readonly oauthBaseUrl?: string
  readonly apiVersion: string
  readonly requestTimeoutMs: number
  readonly userAgent: string
  readonly tokenCipher: GitHubTokenCipher
  readonly userTokenStore: GitHubUserTokenStore
  readonly tokenEarlyRefreshMs?: number
  readonly refreshLeaseMs?: number
  readonly refreshLeasePollMs?: number
  readonly logger?: GitHubClientLogger
  readonly fetchImplementation?: typeof fetch
  readonly clientFactory?: GitHubClientFactory
  readonly oauthClient?: GitHubOAuthClient
  readonly now?: () => Date
  readonly createLeaseId?: () => string
}

interface CachedClient<Client> {
  readonly client: Client
  readonly usableUntil: number
}

interface NormalizedInstallationScope {
  readonly cacheKey: string
  readonly repositoryIds: readonly number[] | undefined
  readonly permissions: InstallationPermissions
}

export function createGitHubAuthenticationService(
  options: CreateGitHubAuthenticationServiceOptions,
): GitHubAuthenticationService {
  return new DefaultGitHubAuthenticationService(options)
}

class DefaultGitHubAuthenticationService implements GitHubAuthenticationService {
  readonly #appId: number
  readonly #privateKey: KeyObject
  readonly #apiBaseUrl: string
  readonly #apiVersion: string
  readonly #requestTimeoutMs: number
  readonly #userAgent: string
  readonly #tokenCipher: GitHubTokenCipher
  readonly #userTokenStore: GitHubUserTokenStore
  readonly #tokenEarlyRefreshMs: number
  readonly #refreshLeaseMs: number
  readonly #refreshLeasePollMs: number
  readonly #logger: GitHubClientLogger | undefined
  readonly #fetchImplementation: typeof fetch | undefined
  readonly #clientFactory: GitHubClientFactory
  readonly #oauthClient: GitHubOAuthClient
  readonly #now: () => Date
  readonly #createLeaseId: () => string

  #appClient: CachedClient<AppGitHubClient> | undefined
  readonly #installationClients = new Map<string, CachedClient<InstallationGitHubClient>>()
  readonly #installationCacheKeys = new Map<number, Set<string>>()
  readonly #installationGenerations = new Map<number, number>()
  readonly #userClients = new Map<number, CachedClient<UserGitHubClient>>()
  readonly #userGenerations = new Map<number, number>()
  readonly #forceUserRefresh = new Set<number>()

  #appClientPromise: Promise<AppGitHubClient> | undefined
  readonly #installationClientPromises = new Map<string, Promise<InstallationGitHubClient>>()
  readonly #userClientPromises = new Map<number, Promise<UserGitHubClient>>()

  constructor(options: CreateGitHubAuthenticationServiceOptions) {
    assertPositiveSafeInteger('appId', options.appId)
    assertNonEmpty('clientId', options.clientId)
    assertNonEmpty('clientSecret', options.clientSecret)
    assertNonEmpty('apiVersion', options.apiVersion)
    assertNonEmpty('userAgent', options.userAgent)
    assertPositiveSafeInteger('requestTimeoutMs', options.requestTimeoutMs)

    const tokenEarlyRefreshMs = options.tokenEarlyRefreshMs ?? defaultTokenEarlyRefreshMs
    const refreshLeaseMs = options.refreshLeaseMs ?? defaultRefreshLeaseMs
    const refreshLeasePollMs = options.refreshLeasePollMs ?? defaultRefreshLeasePollMs

    assertPositiveSafeInteger('tokenEarlyRefreshMs', tokenEarlyRefreshMs)
    assertPositiveSafeInteger('refreshLeaseMs', refreshLeaseMs)
    assertPositiveSafeInteger('refreshLeasePollMs', refreshLeasePollMs)

    if (refreshLeaseMs < options.requestTimeoutMs * 3) {
      throw new GitHubAuthenticationError(
        'refreshLeaseMs must be at least three times requestTimeoutMs',
      )
    }

    this.#appId = options.appId
    this.#privateKey =
      typeof options.privateKey === 'string'
        ? loadGitHubAppPrivateKey(options.privateKey)
        : options.privateKey
    this.#apiBaseUrl = normalizeHttpOrigin(options.apiBaseUrl, 'apiBaseUrl')
    this.#apiVersion = options.apiVersion
    this.#requestTimeoutMs = options.requestTimeoutMs
    this.#userAgent = options.userAgent
    this.#tokenCipher = options.tokenCipher
    this.#userTokenStore = options.userTokenStore
    this.#tokenEarlyRefreshMs = tokenEarlyRefreshMs
    this.#refreshLeaseMs = refreshLeaseMs
    this.#refreshLeasePollMs = refreshLeasePollMs
    this.#logger = options.logger
    this.#fetchImplementation = options.fetchImplementation
    this.#clientFactory = options.clientFactory ?? createGitHubClient
    this.#now = options.now ?? (() => new Date())
    this.#createLeaseId = options.createLeaseId ?? randomUUID
    this.#oauthClient =
      options.oauthClient ??
      createGitHubOAuthClient({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        oauthBaseUrl: normalizeHttpOrigin(
          options.oauthBaseUrl ?? 'https://github.com',
          'oauthBaseUrl',
        ),
        requestTimeoutMs: options.requestTimeoutMs,
        userAgent: options.userAgent,
        ...(options.fetchImplementation !== undefined
          ? { fetchImplementation: options.fetchImplementation }
          : {}),
        now: this.#now,
      })
  }

  async getAppClient(): Promise<AppGitHubClient> {
    const now = this.#now().getTime()

    if (this.#appClient && this.#appClient.usableUntil > now) {
      return this.#appClient.client
    }

    this.#appClientPromise ??= this.#createAppClient().finally(() => {
      this.#appClientPromise = undefined
    })

    return this.#appClientPromise
  }

  async getInstallationClient(input: {
    installationId: number
    repositoryIds?: number[]
    permissions?: InstallationPermissions
  }): Promise<InstallationGitHubClient> {
    assertPositiveSafeInteger('installationId', input.installationId)

    const scope = normalizeInstallationScope(input)
    const cacheKey = `${input.installationId}:${scope.cacheKey}`
    const now = this.#now().getTime()
    const cached = this.#installationClients.get(cacheKey)

    if (cached && cached.usableUntil > now) {
      return cached.client
    }

    let promise = this.#installationClientPromises.get(cacheKey)

    if (!promise) {
      const generation = this.#getInstallationGeneration(input.installationId)
      promise = this.#createInstallationClient(input.installationId, scope, cacheKey, generation)
      this.#installationClientPromises.set(cacheKey, promise)
      removePromiseWhenSettled(this.#installationClientPromises, cacheKey, promise)
    }

    return promise
  }

  async getUserClient(userId: number): Promise<UserGitHubClient> {
    assertPositiveSafeInteger('userId', userId)

    const now = this.#now().getTime()
    const cached = this.#userClients.get(userId)

    if (cached && cached.usableUntil > now && !this.#forceUserRefresh.has(userId)) {
      return cached.client
    }

    let promise = this.#userClientPromises.get(userId)

    if (!promise) {
      const generation = this.#getUserGeneration(userId)
      promise = this.#resolveUserClient(userId, generation)
      this.#userClientPromises.set(userId, promise)
      removePromiseWhenSettled(this.#userClientPromises, userId, promise)
    }

    return promise
  }

  async authorizeUser(input: {
    readonly code: string
    readonly redirectUri?: string
    readonly expectedUserId?: number
  }): Promise<GitHubUserAuthorizationResult> {
    if (input.expectedUserId !== undefined) {
      assertPositiveSafeInteger('expectedUserId', input.expectedUserId)
    }

    const oauthToken = await this.#oauthClient.exchangeAuthorizationCode({
      code: input.code,
      ...(input.redirectUri !== undefined ? { redirectUri: input.redirectUri } : {}),
    })

    const temporaryClient = this.#createUserClient(0, oauthToken.accessToken, () => undefined)
    const response = await temporaryClient.request('GET /user')
    const userId = getGitHubUserId(response.data)

    if (input.expectedUserId !== undefined && input.expectedUserId !== userId) {
      throw new GitHubAuthenticationError(
        `GitHub authorization belongs to user ${userId}, expected ${input.expectedUserId}`,
      )
    }

    const stored = await this.#userTokenStore.upsert(this.#encryptOAuthToken(userId, oauthToken))
    const generation = this.#advanceUserGeneration(userId)

    this.#userClients.delete(userId)
    this.#userClientPromises.delete(userId)
    this.#forceUserRefresh.delete(userId)
    this.#cacheUserClient(stored, oauthToken.accessToken, generation)

    return {
      userId,
      accessTokenExpiresAt: new Date(oauthToken.accessTokenExpiresAt),
      refreshTokenExpiresAt: new Date(oauthToken.refreshTokenExpiresAt),
    }
  }

  invalidateInstallation(installationId: number): void {
    assertPositiveSafeInteger('installationId', installationId)
    this.#advanceInstallationGeneration(installationId)

    const cacheKeys = this.#installationCacheKeys.get(installationId)

    if (cacheKeys) {
      for (const cacheKey of cacheKeys) {
        this.#installationClients.delete(cacheKey)
        this.#installationClientPromises.delete(cacheKey)
      }
    }

    this.#installationCacheKeys.delete(installationId)
  }

  invalidateUser(userId: number): void {
    assertPositiveSafeInteger('userId', userId)
    this.#advanceUserGeneration(userId)
    this.#userClients.delete(userId)
    this.#userClientPromises.delete(userId)
    this.#forceUserRefresh.add(userId)
  }

  async revokeUser(userId: number): Promise<void> {
    assertPositiveSafeInteger('userId', userId)
    this.#advanceUserGeneration(userId)
    this.#userClients.delete(userId)
    this.#userClientPromises.delete(userId)
    this.#forceUserRefresh.delete(userId)
    await this.#userTokenStore.delete(userId)
  }

  async #createAppClient(): Promise<AppGitHubClient> {
    const credential = createGitHubAppJwtCredential({
      appId: this.#appId,
      privateKey: this.#privateKey,
      now: this.#now(),
    })

    const client = this.#clientFactory({
      auth: credential.token,
      authentication: {
        type: 'app',
        appId: this.#appId,
      },
      apiBaseUrl: this.#apiBaseUrl,
      apiVersion: this.#apiVersion,
      requestTimeoutMs: this.#requestTimeoutMs,
      userAgent: this.#userAgent,
      ...(this.#logger !== undefined ? { logger: this.#logger } : {}),
      ...(this.#fetchImplementation !== undefined
        ? { fetchImplementation: this.#fetchImplementation }
        : {}),
      onUnauthorized: () => {
        this.#appClient = undefined
      },
    }) as AppGitHubClient

    this.#appClient = {
      client,
      usableUntil: credential.expiresAt.getTime() - appJwtEarlyRefreshMs,
    }

    return client
  }

  async #createInstallationClient(
    installationId: number,
    scope: NormalizedInstallationScope,
    cacheKey: string,
    expectedGeneration: number,
  ): Promise<InstallationGitHubClient> {
    const appClient = await this.getAppClient()
    const response = await appClient.request(
      'POST /app/installations/{installation_id}/access_tokens',
      {
        installation_id: installationId,
        permissions: scope.permissions,
        ...(scope.repositoryIds !== undefined
          ? {
              repository_ids: [...scope.repositoryIds],
            }
          : {}),
      },
    )

    const token = getStringProperty(response.data, 'token')
    const expiresAt = getDateProperty(response.data, 'expires_at')

    if (!token || !expiresAt) {
      throw new GitHubAuthenticationError(
        'GitHub installation token response is missing token or expires_at',
      )
    }

    if (this.#getInstallationGeneration(installationId) !== expectedGeneration) {
      throw new GitHubAuthenticationError(
        `GitHub installation ${installationId} was invalidated while its token was being created`,
      )
    }

    const client = this.#clientFactory({
      auth: token,
      authentication: {
        type: 'installation',
        installationId,
        repositoryIds: scope.repositoryIds,
        permissions: scope.permissions,
      },
      apiBaseUrl: this.#apiBaseUrl,
      apiVersion: this.#apiVersion,
      requestTimeoutMs: this.#requestTimeoutMs,
      userAgent: this.#userAgent,
      ...(this.#logger !== undefined ? { logger: this.#logger } : {}),
      ...(this.#fetchImplementation !== undefined
        ? { fetchImplementation: this.#fetchImplementation }
        : {}),
      onUnauthorized: () => {
        this.invalidateInstallation(installationId)
      },
    }) as InstallationGitHubClient

    this.#installationClients.set(cacheKey, {
      client,
      usableUntil: expiresAt.getTime() - this.#tokenEarlyRefreshMs,
    })

    let installationKeys = this.#installationCacheKeys.get(installationId)

    if (!installationKeys) {
      installationKeys = new Set()
      this.#installationCacheKeys.set(installationId, installationKeys)
    }

    installationKeys.add(cacheKey)

    return client
  }

  async #resolveUserClient(userId: number, expectedGeneration: number): Promise<UserGitHubClient> {
    let stored = await this.#userTokenStore.get(userId)

    if (!stored) {
      throw new GitHubUserAuthorizationNotFoundError(userId)
    }

    if (this.#mustRefreshUserToken(userId, stored)) {
      stored = await this.#refreshUserToken(userId, stored)
    }

    const accessToken = this.#tokenCipher.decrypt({
      userId,
      purpose: 'access',
      encryptedToken: stored.encryptedAccessToken,
    })

    this.#forceUserRefresh.delete(userId)

    return this.#cacheUserClient(stored, accessToken, expectedGeneration)
  }

  async #refreshUserToken(
    userId: number,
    initial: StoredGitHubUserCredentials,
  ): Promise<StoredGitHubUserCredentials> {
    const waitDeadline = this.#now().getTime() + this.#refreshLeaseMs + this.#requestTimeoutMs
    let expected = initial

    while (true) {
      const now = this.#now()

      if (expected.refreshTokenExpiresAt.getTime() <= now.getTime()) {
        await this.revokeUser(userId)
        throw new GitHubUserReauthorizationRequiredError(userId, 'GitHub refresh token expired')
      }

      const leaseId = this.#createLeaseId()
      const leaseResult = await this.#userTokenStore.tryAcquireRefreshLease({
        userId,
        expectedVersion: expected.version,
        leaseId,
        leaseExpiresAt: new Date(now.getTime() + this.#refreshLeaseMs),
        now,
      })

      if (leaseResult === 'missing') {
        throw new GitHubUserAuthorizationNotFoundError(userId)
      }

      if (leaseResult === 'acquired') {
        return this.#refreshUserTokenUnderLease(userId, expected, leaseId)
      }

      if (this.#now().getTime() >= waitDeadline) {
        throw new GitHubUserTokenRotationError(
          userId,
          'Timed out waiting for another process to rotate the token',
        )
      }

      await delay(this.#refreshLeasePollMs)

      const current = await this.#userTokenStore.get(userId)

      if (!current) {
        throw new GitHubUserAuthorizationNotFoundError(userId)
      }

      if (current.version !== expected.version && !this.#mustRefreshUserToken(userId, current)) {
        return current
      }

      expected = current
    }
  }

  async #refreshUserTokenUnderLease(
    userId: number,
    stored: StoredGitHubUserCredentials,
    leaseId: string,
  ): Promise<StoredGitHubUserCredentials> {
    try {
      const refreshToken = this.#tokenCipher.decrypt({
        userId,
        purpose: 'refresh',
        encryptedToken: stored.encryptedRefreshToken,
      })
      const oauthToken = await this.#oauthClient.refreshUserToken(refreshToken)
      const encrypted = this.#encryptOAuthToken(userId, oauthToken)
      const committed = await this.#userTokenStore.completeRefresh({
        userId,
        expectedVersion: stored.version,
        leaseId,
        credentials: {
          encryptedAccessToken: encrypted.encryptedAccessToken,
          accessTokenExpiresAt: encrypted.accessTokenExpiresAt,
          encryptedRefreshToken: encrypted.encryptedRefreshToken,
          refreshTokenExpiresAt: encrypted.refreshTokenExpiresAt,
        },
      })

      if (committed) {
        return committed
      }

      const current = await this.#userTokenStore.get(userId)

      if (current && current.version !== stored.version) {
        return current
      }

      throw new GitHubUserTokenRotationError(
        userId,
        'Refresh token rotated remotely but local atomic commit did not complete',
      )
    } catch (error) {
      await this.#userTokenStore.releaseRefreshLease({
        userId,
        expectedVersion: stored.version,
        leaseId,
      })

      if (error instanceof GitHubOAuthRequestError && error.code === 'bad_refresh_token') {
        await this.revokeUser(userId)
        throw new GitHubUserReauthorizationRequiredError(
          userId,
          'GitHub refresh token is invalid or revoked',
        )
      }

      throw error
    }
  }

  #mustRefreshUserToken(userId: number, stored: StoredGitHubUserCredentials): boolean {
    const earlyExpiry = this.#now().getTime() + this.#tokenEarlyRefreshMs

    return (
      this.#forceUserRefresh.has(userId) ||
      stored.accessTokenExpiresAt.getTime() <= earlyExpiry ||
      stored.refreshTokenExpiresAt.getTime() <= earlyExpiry
    )
  }

  #encryptOAuthToken(
    userId: number,
    oauthToken: GitHubOAuthToken,
  ): StoredGitHubUserCredentialInput {
    return {
      userId,
      encryptedAccessToken: this.#tokenCipher.encrypt({
        userId,
        purpose: 'access',
        token: oauthToken.accessToken,
      }),
      accessTokenExpiresAt: new Date(oauthToken.accessTokenExpiresAt),
      encryptedRefreshToken: this.#tokenCipher.encrypt({
        userId,
        purpose: 'refresh',
        token: oauthToken.refreshToken,
      }),
      refreshTokenExpiresAt: new Date(oauthToken.refreshTokenExpiresAt),
    }
  }

  #cacheUserClient(
    stored: StoredGitHubUserCredentials,
    accessToken: string,
    expectedGeneration: number,
  ): UserGitHubClient {
    const userId = stored.userId

    if (this.#getUserGeneration(userId) !== expectedGeneration) {
      throw new GitHubAuthenticationError(
        `GitHub user ${userId} was invalidated while credentials were being resolved`,
      )
    }
    const client = this.#createUserClient(userId, accessToken, () => {
      this.invalidateUser(userId)
    })

    this.#userClients.set(userId, {
      client,
      usableUntil: stored.accessTokenExpiresAt.getTime() - this.#tokenEarlyRefreshMs,
    })

    return client
  }

  #getInstallationGeneration(installationId: number): number {
    return this.#installationGenerations.get(installationId) ?? 0
  }

  #advanceInstallationGeneration(installationId: number): number {
    const generation = this.#getInstallationGeneration(installationId) + 1
    this.#installationGenerations.set(installationId, generation)

    return generation
  }

  #getUserGeneration(userId: number): number {
    return this.#userGenerations.get(userId) ?? 0
  }

  #advanceUserGeneration(userId: number): number {
    const generation = this.#getUserGeneration(userId) + 1
    this.#userGenerations.set(userId, generation)

    return generation
  }

  #createUserClient(
    userId: number,
    accessToken: string,
    onUnauthorized: () => Promise<void> | void,
  ): UserGitHubClient {
    return this.#clientFactory({
      auth: accessToken,
      authentication: {
        type: 'user',
        userId,
      },
      apiBaseUrl: this.#apiBaseUrl,
      apiVersion: this.#apiVersion,
      requestTimeoutMs: this.#requestTimeoutMs,
      userAgent: this.#userAgent,
      ...(this.#logger !== undefined ? { logger: this.#logger } : {}),
      ...(this.#fetchImplementation !== undefined
        ? { fetchImplementation: this.#fetchImplementation }
        : {}),
      onUnauthorized,
    }) as UserGitHubClient
  }
}

function removePromiseWhenSettled<Key, Value>(
  promises: Map<Key, Promise<Value>>,
  key: Key,
  promise: Promise<Value>,
): void {
  void promise.then(
    () => {
      if (promises.get(key) === promise) {
        promises.delete(key)
      }
    },
    () => {
      if (promises.get(key) === promise) {
        promises.delete(key)
      }
    },
  )
}

function normalizeInstallationScope(input: {
  readonly repositoryIds?: readonly number[]
  readonly permissions?: InstallationPermissions
}): NormalizedInstallationScope {
  const repositoryIds = normalizeRepositoryIds(input.repositoryIds)
  const permissions = normalizePermissions(input.permissions)
  const permissionKey = Object.entries(permissions)
    .map(([permission, level]) => `${permission}:${level}`)
    .join(',')
  const repositoryKey = repositoryIds?.join(',') ?? '*'

  return {
    cacheKey: `repositories=${repositoryKey};permissions=${permissionKey}`,
    repositoryIds,
    permissions,
  }
}

function normalizeRepositoryIds(
  repositoryIds: readonly number[] | undefined,
): readonly number[] | undefined {
  if (repositoryIds === undefined) {
    return undefined
  }

  if (repositoryIds.length === 0) {
    throw new GitHubInstallationScopeError(
      'repositoryIds must contain at least one repository when specified',
    )
  }

  if (repositoryIds.length > maximumInstallationRepositoryCount) {
    throw new GitHubInstallationScopeError(
      `repositoryIds cannot contain more than ${maximumInstallationRepositoryCount} repositories`,
    )
  }

  const normalized = [...new Set(repositoryIds)]

  for (const repositoryId of normalized) {
    assertPositiveSafeInteger('repositoryId', repositoryId)
  }

  return Object.freeze(normalized.sort((left, right) => left - right))
}

function normalizePermissions(
  permissions: InstallationPermissions | undefined,
): InstallationPermissions {
  const entries = Object.entries(permissions ?? defaultInstallationPermissions) as Array<
    [InstallationPermissionName, InstallationPermissionLevel]
  >

  if (entries.length === 0) {
    return defaultInstallationPermissions
  }

  const normalized: Partial<Record<InstallationPermissionName, InstallationPermissionLevel>> = {}

  for (const [permission, level] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!Object.hasOwn(GITHUB_APP_REPOSITORY_PERMISSIONS, permission)) {
      throw new GitHubInstallationScopeError(
        `Permission ${permission} is not granted to the Shipgate GitHub App`,
      )
    }

    if (level !== 'read' && level !== 'write') {
      throw new GitHubInstallationScopeError(`Permission ${permission} must be read or write`)
    }

    const maximumLevel = GITHUB_APP_REPOSITORY_PERMISSIONS[permission]

    if (level === 'write' && maximumLevel !== 'write') {
      throw new GitHubInstallationScopeError(
        `Permission ${permission}: write exceeds the GitHub App registration`,
      )
    }

    normalized[permission] = level
  }

  return Object.freeze(normalized)
}

function getGitHubUserId(value: unknown): number {
  const id = getNumberProperty(value, 'id')

  if (id === undefined || !Number.isSafeInteger(id) || id <= 0) {
    throw new GitHubAuthenticationError('GitHub GET /user response is missing a valid numeric ID')
  }

  return id
}

function getDateProperty(value: unknown, key: string): Date | undefined {
  const property = getStringProperty(value, key)

  if (!property) {
    return undefined
  }

  const date = new Date(property)

  return Number.isNaN(date.getTime()) ? undefined : date
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined
  }

  const property = Reflect.get(value, key)

  return typeof property === 'string' ? property : undefined
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined
  }

  const property = Reflect.get(value, key)

  return typeof property === 'number' ? property : undefined
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubAuthenticationError(`${name} must be a positive safe integer`)
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new GitHubAuthenticationError(`${name} must not be empty`)
  }
}

function normalizeHttpOrigin(value: string, name: string): string {
  const url = new URL(value)

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new GitHubAuthenticationError(`${name} must be an exact HTTP origin`)
  }

  return url.origin
}
