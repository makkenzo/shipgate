import type { DatabaseClient } from '@shipgate/database'
import type { GitHubAuthenticationService, UserGitHubClient } from '@shipgate/github'

import type { GitHubInstallationSummary } from '../auth/model.js'
import { createRepositoryAccessCache, type RepositoryAccessCache } from './cache.js'
import {
  getGitHubErrorStatus,
  listGitHubInstallationRepositories,
  listGitHubUserInstallationRepositories,
  loadGitHubInstallationMetadata,
} from './github.js'
import type {
  GitHubInstallationMetadata,
  GitHubInstallationRepository,
  GitHubUserRepositoryAccess,
  ReconciledInstallationAccess,
  RepositoryAccessDecision,
  RepositoryAccessDenialReason,
  RequiredRepositoryPermission,
} from './model.js'
import {
  assertPositiveGitHubId,
  assertRequiredRepositoryPermission,
  createInaccessibleRepositoryAccessDecision,
  createRepositoryAccessDecision,
} from './permissions.js'
import {
  markGitHubInstallationPermissionState,
  replaceGitHubInstallationSnapshot,
} from './store.js'

export interface GitHubRepositoryAccessService {
  reconcileUserInstallations(input: {
    readonly githubUserId: number
    readonly userClient: UserGitHubClient
    readonly installations: readonly GitHubInstallationSummary[]
  }): Promise<readonly GitHubInstallationSummary[]>

  authorizeRepositoryAccess(input: {
    readonly githubUserId: number
    readonly installationId: number
    readonly repositoryId: number
    readonly requiredPermission: RequiredRepositoryPermission
  }): Promise<RepositoryAccessDecision>

  invalidateAll(): void
  invalidateInstallation(installationId: number): void
  invalidateUser(githubUserId: number): void
}

export type GitHubRepositoryAccessVerificationStage =
  | 'resolve_user_client'
  | 'installation_metadata'
  | 'persist_installation_metadata'
  | 'installation_repositories'
  | 'user_repositories'
  | 'persist_installation_snapshot'
  | 'cache'
  | 'reconciliation_invalidated'

export class GitHubRepositoryAccessVerificationError extends Error {
  readonly githubUserId: number
  readonly installationId: number
  readonly stage: GitHubRepositoryAccessVerificationStage
  readonly status: number | undefined

  constructor(
    message: string,
    options: {
      readonly githubUserId: number
      readonly installationId: number
      readonly stage: GitHubRepositoryAccessVerificationStage
      readonly status?: number
      readonly cause?: unknown
    },
  ) {
    super(message, {
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })

    this.name = 'GitHubRepositoryAccessVerificationError'
    this.githubUserId = options.githubUserId
    this.installationId = options.installationId
    this.stage = options.stage
    this.status = options.status
  }
}

export function createGitHubRepositoryAccessService(options: {
  readonly database: DatabaseClient
  readonly githubAuth: GitHubAuthenticationService
  readonly cacheTtlMs?: number
  readonly now?: () => Date
}): GitHubRepositoryAccessService {
  return new DefaultGitHubRepositoryAccessService(options)
}

type ReconciliationOutcome =
  | {
      readonly type: 'reconciled'
      readonly snapshot: ReconciledInstallationAccess
    }
  | {
      readonly type: 'inaccessible'
      readonly reason: Extract<
        RepositoryAccessDenialReason,
        'installation_not_accessible' | 'installation_revoked'
      >
      readonly verifiedAt: Date
      readonly cacheExpiresAt: Date
    }

interface ReconciliationGeneration {
  readonly global: number
  readonly user: number
  readonly installation: number
}

class DefaultGitHubRepositoryAccessService implements GitHubRepositoryAccessService {
  readonly #database: DatabaseClient
  readonly #githubAuth: GitHubAuthenticationService
  readonly #now: () => Date
  readonly #cache: RepositoryAccessCache
  readonly #reconciliations = new Map<string, Promise<ReconciliationOutcome>>()
  readonly #userGenerations = new Map<number, number>()
  readonly #installationGenerations = new Map<number, number>()
  #globalGeneration = 0

  constructor(options: {
    readonly database: DatabaseClient
    readonly githubAuth: GitHubAuthenticationService
    readonly cacheTtlMs?: number
    readonly now?: () => Date
  }) {
    this.#database = options.database
    this.#githubAuth = options.githubAuth
    this.#now = options.now ?? (() => new Date())
    this.#cache = createRepositoryAccessCache({
      ...(options.cacheTtlMs !== undefined ? { ttlMs: options.cacheTtlMs } : {}),
      now: this.#now,
    })
  }

  async reconcileUserInstallations(input: {
    readonly githubUserId: number
    readonly userClient: UserGitHubClient
    readonly installations: readonly GitHubInstallationSummary[]
  }): Promise<readonly GitHubInstallationSummary[]> {
    assertPositiveGitHubId(input.githubUserId, 'githubUserId')
    this.invalidateUser(input.githubUserId)

    const reconciled: GitHubInstallationSummary[] = []

    for (const installation of input.installations) {
      const outcome = await this.#reconcileInstallation({
        githubUserId: input.githubUserId,
        installationId: installation.id,
        userClient: input.userClient,
      })

      if (outcome.type === 'reconciled') {
        reconciled.push(outcome.snapshot.installation.summary)
      }
    }

    return reconciled
  }

  async authorizeRepositoryAccess(input: {
    readonly githubUserId: number
    readonly installationId: number
    readonly repositoryId: number
    readonly requiredPermission: RequiredRepositoryPermission
  }): Promise<RepositoryAccessDecision> {
    assertPositiveGitHubId(input.githubUserId, 'githubUserId')
    assertPositiveGitHubId(input.installationId, 'installationId')
    assertPositiveGitHubId(input.repositoryId, 'repositoryId')
    assertRequiredRepositoryPermission(input.requiredPermission)

    const localDenial = await this.#getLocalDenial(input)

    if (localDenial) {
      this.#cache.invalidateInstallation(input.installationId)
      return localDenial
    }

    const cached = this.#cache.get(input)

    if (cached) {
      return createRepositoryAccessDecision(cached, input.requiredPermission)
    }

    let userClient: UserGitHubClient

    try {
      userClient = await this.#githubAuth.getUserClient(input.githubUserId)
    } catch (error) {
      return this.#throwVerificationFailure(input, 'resolve_user_client', error, this.#now())
    }

    const outcome = await this.#reconcileInstallation({
      githubUserId: input.githubUserId,
      installationId: input.installationId,
      repositoryId: input.repositoryId,
      userClient,
    })

    if (outcome.type === 'inaccessible') {
      return createInaccessibleRepositoryAccessDecision({
        ...input,
        reason: outcome.reason,
        verifiedAt: outcome.verifiedAt,
        cacheExpiresAt: outcome.cacheExpiresAt,
      })
    }

    let refreshed = this.#cache.get(input)

    if (!refreshed) {
      this.#cache.primeSnapshot({
        githubUserId: input.githubUserId,
        snapshot: outcome.snapshot,
        requestedRepositoryId: input.repositoryId,
      })
      refreshed = this.#cache.get(input)
    }

    if (!refreshed) {
      throw new GitHubRepositoryAccessVerificationError(
        'GitHub repository access reconciliation did not produce a cache entry',
        {
          githubUserId: input.githubUserId,
          installationId: input.installationId,
          stage: 'cache',
        },
      )
    }

    return createRepositoryAccessDecision(refreshed, input.requiredPermission)
  }

  invalidateAll(): void {
    this.#globalGeneration += 1
    this.#reconciliations.clear()
    this.#cache.invalidateAll()
  }

  invalidateInstallation(installationId: number): void {
    assertPositiveGitHubId(installationId, 'installationId')
    this.#installationGenerations.set(
      installationId,
      this.#getInstallationGeneration(installationId) + 1,
    )
    this.#deleteReconciliations((key) => key.endsWith(`:${installationId}`))
    this.#cache.invalidateInstallation(installationId)
  }

  invalidateUser(githubUserId: number): void {
    assertPositiveGitHubId(githubUserId, 'githubUserId')
    this.#userGenerations.set(githubUserId, this.#getUserGeneration(githubUserId) + 1)
    this.#deleteReconciliations((key) => key.startsWith(`${githubUserId}:`))
    this.#cache.invalidateUser(githubUserId)
  }

  #reconcileInstallation(input: {
    readonly githubUserId: number
    readonly installationId: number
    readonly repositoryId?: number
    readonly userClient: UserGitHubClient
  }): Promise<ReconciliationOutcome> {
    assertPositiveGitHubId(input.installationId, 'installationId')

    const key = `${input.githubUserId}:${input.installationId}`
    const existing = this.#reconciliations.get(key)

    if (existing) {
      return existing
    }

    const generation = this.#captureGeneration(input.githubUserId, input.installationId)
    const promise = this.#performReconciliation({
      ...input,
      generation,
    }).finally(() => {
      if (this.#reconciliations.get(key) === promise) {
        this.#reconciliations.delete(key)
      }
    })

    this.#reconciliations.set(key, promise)

    return promise
  }

  async #performReconciliation(input: {
    readonly githubUserId: number
    readonly installationId: number
    readonly repositoryId?: number
    readonly userClient: UserGitHubClient
    readonly generation: ReconciliationGeneration
  }): Promise<ReconciliationOutcome> {
    const reconciledAt = this.#now()
    const cacheExpiresAt = this.#cache.createExpiry(reconciledAt)
    let installation: GitHubInstallationMetadata

    try {
      const appClient = await this.#githubAuth.getAppClient()
      installation = await loadGitHubInstallationMetadata(appClient, input.installationId)
    } catch (error) {
      const status = getGitHubErrorStatus(error)

      if (status === 404) {
        this.#assertReconciliationCurrent(input)
        await this.#markRevoked(input, reconciledAt, cacheExpiresAt)

        return createInaccessibleOutcome('installation_revoked', reconciledAt, cacheExpiresAt)
      }

      return this.#throwVerificationFailure(input, 'installation_metadata', error, reconciledAt)
    }

    this.#assertReconciliationCurrent(input)

    const metadataSnapshot: ReconciledInstallationAccess = {
      installation,
      repositories: [],
      userRepositories: [],
      reconciledAt,
    }

    await this.#assertInstallationAcceptsReconciliation(input.githubUserId, input.installationId)

    try {
      await replaceGitHubInstallationSnapshot(this.#database, metadataSnapshot, {
        replaceRepositories: false,
        permissionState: installation.summary.suspendedAt === null ? 'stale' : 'suspended',
      })
    } catch (error) {
      return this.#throwVerificationFailure(
        input,
        'persist_installation_metadata',
        error,
        reconciledAt,
      )
    }
    this.#assertReconciliationCurrent(input)

    if (installation.summary.suspendedAt !== null) {
      this.#cache.primeSnapshot({
        githubUserId: input.githubUserId,
        snapshot: metadataSnapshot,
        ...(input.repositoryId !== undefined ? { requestedRepositoryId: input.repositoryId } : {}),
      })

      return {
        type: 'reconciled',
        snapshot: metadataSnapshot,
      }
    }

    let repositories: readonly GitHubInstallationRepository[]

    try {
      const installationClient = await this.#githubAuth.getInstallationClient({
        installationId: input.installationId,
        permissions: {
          metadata: 'read',
        },
      })
      repositories = await listGitHubInstallationRepositories(installationClient)
    } catch (error) {
      const status = getGitHubErrorStatus(error)

      if (status === 404) {
        this.#assertReconciliationCurrent(input)
        await this.#markRevoked(input, reconciledAt, cacheExpiresAt)

        return createInaccessibleOutcome('installation_revoked', reconciledAt, cacheExpiresAt)
      }

      return this.#throwVerificationFailure(input, 'installation_repositories', error, reconciledAt)
    }

    this.#assertReconciliationCurrent(input)

    let userRepositories: readonly GitHubUserRepositoryAccess[]

    try {
      userRepositories = await listGitHubUserInstallationRepositories(
        input.userClient,
        input.installationId,
      )
    } catch (error) {
      const status = getGitHubErrorStatus(error)

      if (status === 404) {
        const snapshot: ReconciledInstallationAccess = {
          installation,
          repositories,
          userRepositories: [],
          reconciledAt,
        }

        this.#assertReconciliationCurrent(input)
        await this.#assertInstallationAcceptsReconciliation(
          input.githubUserId,
          input.installationId,
        )

        try {
          await replaceGitHubInstallationSnapshot(this.#database, snapshot)
        } catch (persistError) {
          return this.#throwVerificationFailure(
            input,
            'persist_installation_snapshot',
            persistError,
            reconciledAt,
          )
        }

        this.#assertReconciliationCurrent(input)
        this.#cache.primeSnapshot({
          githubUserId: input.githubUserId,
          snapshot,
          installationState: 'inaccessible',
          ...(input.repositoryId !== undefined
            ? { requestedRepositoryId: input.repositoryId }
            : {}),
        })

        return createInaccessibleOutcome(
          'installation_not_accessible',
          reconciledAt,
          cacheExpiresAt,
        )
      }

      return this.#throwVerificationFailure(input, 'user_repositories', error, reconciledAt)
    }

    this.#assertReconciliationCurrent(input)

    const snapshot: ReconciledInstallationAccess = {
      installation,
      repositories,
      userRepositories,
      reconciledAt,
    }

    await this.#assertInstallationAcceptsReconciliation(input.githubUserId, input.installationId)

    try {
      await replaceGitHubInstallationSnapshot(this.#database, snapshot)
    } catch (error) {
      return this.#throwVerificationFailure(
        input,
        'persist_installation_snapshot',
        error,
        reconciledAt,
      )
    }

    this.#assertReconciliationCurrent(input)
    this.#cache.primeSnapshot({
      githubUserId: input.githubUserId,
      snapshot,
      ...(input.repositoryId !== undefined ? { requestedRepositoryId: input.repositoryId } : {}),
    })

    return {
      type: 'reconciled',
      snapshot,
    }
  }

  async #assertInstallationAcceptsReconciliation(
    githubUserId: number,
    installationId: number,
  ): Promise<void> {
    const row = await this.#database.kysely
      .selectFrom('github_installations')
      .select('lifecycle_state')
      .where('installation_id', '=', String(installationId))
      .executeTakeFirst()

    if (row?.lifecycle_state === 'pending_deletion' || row?.lifecycle_state === 'deleted') {
      throw new GitHubRepositoryAccessVerificationError(
        `GitHub installation ${installationId} is pending deletion`,
        { githubUserId, installationId, stage: 'reconciliation_invalidated' },
      )
    }
  }

  async #getLocalDenial(input: {
    readonly githubUserId: number
    readonly installationId: number
    readonly repositoryId: number
    readonly requiredPermission: RequiredRepositoryPermission
  }): Promise<RepositoryAccessDecision | undefined> {
    const verifiedAt = this.#now()
    const cacheExpiresAt = this.#cache.createExpiry(verifiedAt)
    const installationId = String(input.installationId)
    const repositoryId = String(input.repositoryId)
    const installation = await this.#database.kysely
      .selectFrom('github_installations')
      .select(['lifecycle_state', 'permission_state'])
      .where('installation_id', '=', installationId)
      .executeTakeFirst()

    if (
      installation?.lifecycle_state === 'suspended' ||
      installation?.permission_state === 'suspended'
    ) {
      return {
        allowed: false,
        reason: 'installation_suspended',
        githubUserId: input.githubUserId,
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        repositoryPermission: 'none',
        requiredPermission: input.requiredPermission,
        verifiedAt,
        cacheExpiresAt,
      }
    }

    if (
      installation?.lifecycle_state === 'pending_deletion' ||
      installation?.lifecycle_state === 'deleted' ||
      installation?.permission_state === 'revoked'
    ) {
      return createInaccessibleRepositoryAccessDecision({
        ...input,
        reason: 'installation_revoked',
        verifiedAt,
        cacheExpiresAt,
      })
    }

    if (installation) {
      const repository = await this.#database.kysely
        .selectFrom('github_installation_repositories')
        .select('repository_id')
        .where('installation_id', '=', installationId)
        .where('repository_id', '=', repositoryId)
        .executeTakeFirst()

      if (!repository) {
        return {
          allowed: false,
          reason: 'repository_not_selected',
          githubUserId: input.githubUserId,
          installationId: input.installationId,
          repositoryId: input.repositoryId,
          repositoryPermission: 'none',
          requiredPermission: input.requiredPermission,
          verifiedAt,
          cacheExpiresAt,
        }
      }
    }

    return undefined
  }

  #captureGeneration(githubUserId: number, installationId: number): ReconciliationGeneration {
    return {
      global: this.#globalGeneration,
      user: this.#getUserGeneration(githubUserId),
      installation: this.#getInstallationGeneration(installationId),
    }
  }

  #assertReconciliationCurrent(input: {
    readonly githubUserId: number
    readonly installationId: number
    readonly generation: ReconciliationGeneration
  }): void {
    const current = this.#captureGeneration(input.githubUserId, input.installationId)

    if (
      current.global !== input.generation.global ||
      current.user !== input.generation.user ||
      current.installation !== input.generation.installation
    ) {
      throw new GitHubRepositoryAccessVerificationError(
        `GitHub repository access for installation ${input.installationId} was invalidated during reconciliation`,
        {
          githubUserId: input.githubUserId,
          installationId: input.installationId,
          stage: 'reconciliation_invalidated',
        },
      )
    }
  }

  #getUserGeneration(githubUserId: number): number {
    return this.#userGenerations.get(githubUserId) ?? 0
  }

  #getInstallationGeneration(installationId: number): number {
    return this.#installationGenerations.get(installationId) ?? 0
  }

  #deleteReconciliations(predicate: (key: string) => boolean): void {
    for (const key of this.#reconciliations.keys()) {
      if (predicate(key)) {
        this.#reconciliations.delete(key)
      }
    }
  }

  async #markRevoked(
    input: {
      readonly githubUserId: number
      readonly installationId: number
      readonly repositoryId?: number
    },
    reconciledAt: Date,
    cacheExpiresAt: Date,
  ): Promise<void> {
    await markGitHubInstallationPermissionState({
      database: this.#database,
      installationId: input.installationId,
      state: 'revoked',
      reconciledAt,
    })
    this.#cache.primeInstallationDenial({
      githubUserId: input.githubUserId,
      installationId: input.installationId,
      state: 'revoked',
      verifiedAt: reconciledAt,
      expiresAt: cacheExpiresAt,
      ...(input.repositoryId !== undefined ? { repositoryId: input.repositoryId } : {}),
    })
  }

  async #throwVerificationFailure(
    input: {
      readonly githubUserId: number
      readonly installationId: number
    },
    stage: GitHubRepositoryAccessVerificationStage,
    error: unknown,
    reconciledAt: Date,
  ): Promise<never> {
    const status = getGitHubErrorStatus(error)

    this.invalidateUser(input.githubUserId)
    this.invalidateInstallation(input.installationId)

    if (status === 401 || status === 403) {
      this.#githubAuth.invalidateInstallation(input.installationId)

      if (status === 401) {
        this.#githubAuth.invalidateUser(input.githubUserId)
      }
    }

    await markGitHubInstallationPermissionState({
      database: this.#database,
      installationId: input.installationId,
      state: 'stale',
      reconciledAt,
    })

    throw new GitHubRepositoryAccessVerificationError(
      `Unable to verify GitHub repository access for installation ${input.installationId}`,
      {
        githubUserId: input.githubUserId,
        installationId: input.installationId,
        stage,
        ...(status !== undefined ? { status } : {}),
        cause: error,
      },
    )
  }
}

function createInaccessibleOutcome(
  reason: Extract<
    RepositoryAccessDenialReason,
    'installation_not_accessible' | 'installation_revoked'
  >,
  verifiedAt: Date,
  cacheExpiresAt: Date,
): ReconciliationOutcome {
  return {
    type: 'inaccessible',
    reason,
    verifiedAt,
    cacheExpiresAt,
  }
}
