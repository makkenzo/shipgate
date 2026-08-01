import type { GitHubRepositoryPermission, ReconciledInstallationAccess } from './model.js'

const maximumCacheTtlMs = 5 * 60_000

export type CachedInstallationState = 'current' | 'suspended' | 'revoked' | 'inaccessible'

export interface CachedRepositoryAccess {
  readonly githubUserId: number
  readonly installationId: number
  readonly repositoryId: number
  readonly installationState: CachedInstallationState
  readonly repositorySelected: boolean
  readonly repositoryPermission: GitHubRepositoryPermission
  readonly appPermissions: Readonly<Record<string, string>>
  readonly verifiedAt: Date
  readonly expiresAt: Date
}

export interface RepositoryAccessCache {
  get(input: {
    readonly githubUserId: number
    readonly installationId: number
    readonly repositoryId: number
  }): CachedRepositoryAccess | undefined

  createExpiry(verifiedAt: Date): Date

  primeSnapshot(input: {
    readonly githubUserId: number
    readonly snapshot: ReconciledInstallationAccess
    readonly requestedRepositoryId?: number
    readonly installationState?: CachedInstallationState
  }): void

  primeInstallationDenial(input: {
    readonly githubUserId: number
    readonly installationId: number
    readonly repositoryId?: number
    readonly state: Extract<CachedInstallationState, 'revoked'>
    readonly verifiedAt: Date
    readonly expiresAt: Date
  }): void

  invalidateAll(): void
  invalidateInstallation(installationId: number): void
  invalidateUser(githubUserId: number): void
}

export function createRepositoryAccessCache(options: {
  readonly ttlMs?: number
  readonly now?: () => Date
}): RepositoryAccessCache {
  const ttlMs = options.ttlMs ?? maximumCacheTtlMs

  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > maximumCacheTtlMs) {
    throw new RangeError(
      `GitHub repository access cache TTL must be between 1 and ${maximumCacheTtlMs}ms`,
    )
  }

  return new DefaultRepositoryAccessCache(ttlMs, options.now ?? (() => new Date()))
}

class DefaultRepositoryAccessCache implements RepositoryAccessCache {
  readonly #ttlMs: number
  readonly #now: () => Date
  readonly #entries = new Map<string, CachedRepositoryAccess>()

  constructor(ttlMs: number, now: () => Date) {
    this.#ttlMs = ttlMs
    this.#now = now
  }

  get(input: {
    readonly githubUserId: number
    readonly installationId: number
    readonly repositoryId: number
  }): CachedRepositoryAccess | undefined {
    const key = createCacheKey(input.githubUserId, input.installationId, input.repositoryId)
    const cached = this.#entries.get(key)

    if (!cached) {
      return undefined
    }

    if (cached.expiresAt.getTime() <= this.#now().getTime()) {
      this.#entries.delete(key)
      return undefined
    }

    return cached
  }

  createExpiry(verifiedAt: Date): Date {
    return new Date(verifiedAt.getTime() + this.#ttlMs)
  }

  primeSnapshot(input: {
    readonly githubUserId: number
    readonly snapshot: ReconciledInstallationAccess
    readonly requestedRepositoryId?: number
    readonly installationState?: CachedInstallationState
  }): void {
    const installationId = input.snapshot.installation.summary.id
    const verifiedAt = new Date(input.snapshot.reconciledAt)
    const expiresAt = this.createExpiry(verifiedAt)
    const userRepositories = new Map(
      input.snapshot.userRepositories.map((access) => [access.repository.id, access] as const),
    )
    const installationState =
      input.installationState ??
      (input.snapshot.installation.summary.suspendedAt === null ? 'current' : 'suspended')

    this.#invalidateUserInstallation(input.githubUserId, installationId)

    for (const repository of input.snapshot.repositories) {
      const userAccess = userRepositories.get(repository.id)

      this.#entries.set(createCacheKey(input.githubUserId, installationId, repository.id), {
        githubUserId: input.githubUserId,
        installationId,
        repositoryId: repository.id,
        installationState,
        repositorySelected: true,
        repositoryPermission: userAccess?.permission ?? 'none',
        appPermissions: input.snapshot.installation.permissions,
        verifiedAt,
        expiresAt,
      })
    }

    if (
      input.requestedRepositoryId !== undefined &&
      !input.snapshot.repositories.some(
        (repository) => repository.id === input.requestedRepositoryId,
      )
    ) {
      this.#entries.set(
        createCacheKey(input.githubUserId, installationId, input.requestedRepositoryId),
        {
          githubUserId: input.githubUserId,
          installationId,
          repositoryId: input.requestedRepositoryId,
          installationState,
          repositorySelected: false,
          repositoryPermission: 'none',
          appPermissions: input.snapshot.installation.permissions,
          verifiedAt,
          expiresAt,
        },
      )
    }
  }

  primeInstallationDenial(input: {
    readonly githubUserId: number
    readonly installationId: number
    readonly repositoryId?: number
    readonly state: Extract<CachedInstallationState, 'revoked'>
    readonly verifiedAt: Date
    readonly expiresAt: Date
  }): void {
    this.#invalidateUserInstallation(input.githubUserId, input.installationId)

    if (input.repositoryId === undefined) {
      return
    }

    this.#entries.set(
      createCacheKey(input.githubUserId, input.installationId, input.repositoryId),
      {
        githubUserId: input.githubUserId,
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        installationState: input.state,
        repositorySelected: false,
        repositoryPermission: 'none',
        appPermissions: {},
        verifiedAt: input.verifiedAt,
        expiresAt: input.expiresAt,
      },
    )
  }

  invalidateAll(): void {
    this.#entries.clear()
  }

  invalidateInstallation(installationId: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.installationId === installationId) {
        this.#entries.delete(key)
      }
    }
  }

  invalidateUser(githubUserId: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.githubUserId === githubUserId) {
        this.#entries.delete(key)
      }
    }
  }

  #invalidateUserInstallation(githubUserId: number, installationId: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.githubUserId === githubUserId && entry.installationId === installationId) {
        this.#entries.delete(key)
      }
    }
  }
}

function createCacheKey(
  githubUserId: number,
  installationId: number,
  repositoryId: number,
): string {
  return `${githubUserId}:${installationId}:${repositoryId}`
}
