import type { DatabaseClient, DatabaseSchema, JsonValue } from '@shipgate/database'
import type { GitHubAuthenticationService } from '@shipgate/github'
import {
  PermanentJobError,
  type RepositoryIncrementalSyncExecution,
  type RepositoryIncrementalSyncHandler,
  type RepositoryRequiredChecksSyncHandler,
  RetryableJobError,
} from '@shipgate/jobs'
import type { Transaction } from 'kysely'

import { ProjectConfigurationValidationError } from './errors.js'
import {
  parseRepositoryIncrementalSyncScope,
  type RepositoryIncrementalSyncScope,
} from './incremental-sync-queue.js'
import {
  loadRepositoryMetadata,
  type RepositoryHeadState,
  type RepositoryMetadata,
  repositoryInitialSyncPermissions,
  resolveRepositoryHeads,
} from './initial-sync-github.js'
import {
  type RepositoryLock,
  withRepositoryLock,
  withRepositoryTransactionInLock,
} from './repository-transaction.js'
import { queueRepositoryInitialSync } from './sync-queue.js'

interface ClaimedIncrementalSynchronization {
  readonly requestId: string
  readonly projectId: string
  readonly repositoryId: string
  readonly installationId: string
  readonly configurationVersion: number
  readonly syncType: RepositoryIncrementalSyncExecution['syncType']
  readonly scope: RepositoryIncrementalSyncScope
  readonly sourceBranch: string
  readonly productionBranch: string
}

export function createRepositoryIncrementalSyncHandler(options: {
  readonly database: DatabaseClient
  readonly githubAuth: GitHubAuthenticationService
  readonly repositoryRequiredChecksSync: RepositoryRequiredChecksSyncHandler
}): RepositoryIncrementalSyncHandler {
  return async (execution) => {
    const request = await options.database.kysely
      .selectFrom('repository_incremental_sync_requests')
      .select(['id', 'repository_id', 'sync_type', 'status'])
      .where('id', '=', execution.requestId)
      .executeTakeFirst()

    if (!request) {
      return { status: 'ignored', reason: 'request_not_found' }
    }

    if (request.sync_type !== execution.syncType) {
      throw new PermanentJobError('Incremental synchronization task type does not match request', {
        code: 'REPOSITORY_INCREMENTAL_SYNC_TYPE_MISMATCH',
        details: {
          requestId: request.id,
          requestedType: request.sync_type,
          executedType: execution.syncType,
        },
      })
    }

    if (isTerminalStatus(request.status)) {
      return { status: request.status, requestId: request.id }
    }

    const claimed = await withRepositoryLock(options.database, request.repository_id, (lock) =>
      claimIncrementalSynchronization(lock, execution),
    )

    if (!claimed) {
      return { status: 'ignored', reason: 'request_no_longer_runnable' }
    }

    try {
      const result = await executeIncrementalSynchronization(options, claimed, execution)
      const committed = await markIncrementalSynchronizationSucceeded(
        options.database,
        claimed,
        new Date(),
      )

      if (!committed) {
        return { status: 'ignored', reason: 'request_changed_during_refresh' }
      }

      return {
        status: 'applied',
        requestId: claimed.requestId,
        syncType: claimed.syncType,
        result,
      }
    } catch (error) {
      const retryable = isRetryable(error)
      const code = errorCode(error)
      const message = toError(error).message

      if (retryable && execution.attempt < execution.maxAttempts) {
        await recordIncrementalSynchronizationAttempt(options.database, claimed, {
          code,
          message,
          attempt: execution.attempt,
        })
        execution.logger.warn(
          {
            event: 'repository.incremental_sync.retrying',
            requestId: claimed.requestId,
            projectId: claimed.projectId,
            repositoryId: claimed.repositoryId,
            syncType: claimed.syncType,
            attempt: execution.attempt,
            err: toError(error),
          },
          'Repository incremental synchronization will be retried',
        )

        throw new RetryableJobError('Repository incremental synchronization failed temporarily', {
          code,
          details: {
            requestId: claimed.requestId,
            projectId: claimed.projectId,
            syncType: claimed.syncType,
            attempt: execution.attempt,
          },
          cause: error,
        })
      }

      const failure = await markIncrementalSynchronizationFailed(
        options.database,
        claimed,
        error,
        execution,
      )
      execution.logger.error(
        {
          event: 'repository.incremental_sync.failed',
          requestId: claimed.requestId,
          projectId: claimed.projectId,
          repositoryId: claimed.repositoryId,
          syncType: claimed.syncType,
          attempt: execution.attempt,
          retryable,
          err: toError(error),
        },
        'Repository incremental synchronization failed permanently',
      )

      throw new PermanentJobError('Repository incremental synchronization failed permanently', {
        code,
        details: failure,
        cause: error,
      })
    }
  }
}

async function executeIncrementalSynchronization(
  options: {
    readonly database: DatabaseClient
    readonly githubAuth: GitHubAuthenticationService
    readonly repositoryRequiredChecksSync: RepositoryRequiredChecksSyncHandler
  },
  claimed: ClaimedIncrementalSynchronization,
  execution: RepositoryIncrementalSyncExecution,
): Promise<JsonValue> {
  switch (claimed.syncType) {
    case 'refresh_checks':
      return refreshChecks(options.repositoryRequiredChecksSync, claimed, execution)

    case 'refresh_rules':
      return (
        (await options.repositoryRequiredChecksSync({
          projectId: claimed.projectId,
          repositoryId: claimed.repositoryId,
          configurationVersion: claimed.configurationVersion,
          refreshPolicy: true,
          commitSha: undefined,
          reason: firstReason(claimed.scope, 'github_rules_changed'),
          deliveryId: primaryDeliveryId(claimed.scope),
          actorGitHubUserId: undefined,
          attempt: execution.attempt,
          maxAttempts: execution.maxAttempts,
          correlationId: execution.correlationId,
          causationId: execution.causationId,
          signal: execution.signal,
          logger: execution.logger,
        })) ?? null
      )

    case 'refresh_branches':
    case 'refresh_change':
      return observeRepositoryState(options, claimed, execution)
  }
}

async function refreshChecks(
  handler: RepositoryRequiredChecksSyncHandler,
  claimed: ClaimedIncrementalSynchronization,
  execution: RepositoryIncrementalSyncExecution,
): Promise<JsonValue> {
  const results: JsonValue[] = []

  for (const commitSha of claimed.scope.commitShas) {
    const result = await handler({
      projectId: claimed.projectId,
      repositoryId: claimed.repositoryId,
      configurationVersion: claimed.configurationVersion,
      refreshPolicy: false,
      commitSha,
      reason: firstReason(claimed.scope, 'github_check_result_changed'),
      deliveryId: primaryDeliveryId(claimed.scope),
      actorGitHubUserId: undefined,
      attempt: execution.attempt,
      maxAttempts: execution.maxAttempts,
      correlationId: execution.correlationId,
      causationId: execution.causationId,
      signal: execution.signal,
      logger: execution.logger,
    })

    results.push(result ?? null)
  }

  return {
    refreshedCommitShas: claimed.scope.commitShas,
    results,
  }
}

async function observeRepositoryState(
  options: {
    readonly database: DatabaseClient
    readonly githubAuth: GitHubAuthenticationService
  },
  claimed: ClaimedIncrementalSynchronization,
  execution: RepositoryIncrementalSyncExecution,
): Promise<JsonValue> {
  const installationId = parseGitHubId(claimed.installationId, 'installation ID')
  const repositoryId = parseGitHubId(claimed.repositoryId, 'repository ID')
  const client = await options.githubAuth.getInstallationClient({
    installationId,
    repositoryIds: [repositoryId],
    permissions: repositoryInitialSyncPermissions,
  })
  const metadata = await loadRepositoryMetadata(client, repositoryId)
  const heads = await resolveRepositoryHeads(
    client,
    metadata,
    claimed.sourceBranch,
    claimed.productionBranch,
  )
  const now = new Date()

  return withRepositoryLock(options.database, claimed.repositoryId, (lock) =>
    commitObservedRepositoryState(lock, {
      claimed,
      metadata,
      heads,
      execution,
      now,
    }),
  )
}

async function commitObservedRepositoryState(
  lock: RepositoryLock,
  input: {
    readonly claimed: ClaimedIncrementalSynchronization
    readonly metadata: RepositoryMetadata
    readonly heads: RepositoryHeadState
    readonly execution: RepositoryIncrementalSyncExecution
    readonly now: Date
  },
): Promise<JsonValue> {
  return withRepositoryTransactionInLock(lock, async ({ transaction }) => {
    const project = await transaction
      .selectFrom('projects')
      .select([
        'id',
        'configuration_version',
        'status',
        'source_branch',
        'production_branch',
        'source_sha',
        'production_sha',
      ])
      .where('id', '=', input.claimed.projectId)
      .forUpdate()
      .executeTakeFirst()

    if (
      !project ||
      project.configuration_version !== input.claimed.configurationVersion ||
      project.source_branch !== input.claimed.sourceBranch ||
      project.production_branch !== input.claimed.productionBranch ||
      project.status === 'pending_deletion' ||
      project.status === 'deleted'
    ) {
      return { status: 'ignored', reason: 'project_changed_during_refresh' }
    }

    await transaction
      .updateTable('projects')
      .set({
        installation_id: input.claimed.installationId,
        owner_id: String(input.metadata.ownerId),
        owner_login: input.metadata.ownerLogin,
        repository_name: input.metadata.name,
        repository_full_name: input.metadata.fullName,
        default_branch: input.metadata.defaultBranch,
        ...(input.claimed.scope.forced ? { status: 'degraded' as const } : {}),
        updated_at: input.now,
      })
      .where('id', '=', project.id)
      .where('configuration_version', '=', project.configuration_version)
      .executeTakeFirstOrThrow()

    const headsChanged =
      project.source_sha !== input.heads.sourceSha ||
      project.production_sha !== input.heads.productionSha
    const needsReconciliation =
      input.claimed.syncType === 'refresh_change' ||
      headsChanged ||
      input.claimed.scope.forced ||
      input.claimed.scope.requireReconciliation

    if (!needsReconciliation) {
      await upsertBranchObservation(transaction, {
        projectId: project.id,
        repositoryId: input.claimed.repositoryId,
        name: project.source_branch,
        headSha: input.heads.sourceSha,
        protected: input.heads.sourceProtected,
        defaultBranch: input.metadata.defaultBranch === project.source_branch,
        observedAt: input.now,
      })
      await upsertBranchObservation(transaction, {
        projectId: project.id,
        repositoryId: input.claimed.repositoryId,
        name: project.production_branch,
        headSha: input.heads.productionSha,
        protected: input.heads.productionProtected,
        defaultBranch: input.metadata.defaultBranch === project.production_branch,
        observedAt: input.now,
      })

      return {
        status: 'metadata_refreshed',
        sourceSha: input.heads.sourceSha,
        productionSha: input.heads.productionSha,
      }
    }

    const reconciliation = await queueRepositoryInitialSync({
      transaction,
      projectId: project.id,
      repositoryId: input.claimed.repositoryId,
      configurationVersion: input.claimed.configurationVersion,
      reason: input.claimed.scope.forced
        ? 'force_push_detected'
        : firstReason(input.claimed.scope, 'incremental_state_changed'),
      requestedByGitHubUserId: null,
      sourceSha: input.heads.sourceSha,
      productionSha: input.heads.productionSha,
      idempotencyKey: [
        'repository-observed',
        project.id,
        input.claimed.configurationVersion,
        input.claimed.requestId,
      ].join(':'),
      correlationId: input.execution.correlationId,
      causationId:
        input.execution.causationId ??
        `repository-incremental-request:${input.claimed.requestId}:reconcile`,
      triggerScope: input.claimed.scope,
      forcePush: input.claimed.scope.forced,
      now: input.now,
    })

    return {
      status: 'reconciliation_queued',
      reconciliationRequestId: reconciliation.id,
      sourceSha: input.heads.sourceSha,
      productionSha: input.heads.productionSha,
      forcePush: input.claimed.scope.forced,
    }
  })
}

async function upsertBranchObservation(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly projectId: string
    readonly repositoryId: string
    readonly name: string
    readonly headSha: string
    readonly protected: boolean
    readonly defaultBranch: boolean
    readonly observedAt: Date
  },
): Promise<void> {
  const values = {
    repository_id: input.repositoryId,
    head_sha: input.headSha,
    protected: input.protected,
    default_branch: input.defaultBranch,
    observed_at: input.observedAt,
    updated_at: input.observedAt,
  }

  await transaction
    .insertInto('repository_branches')
    .values({
      project_id: input.projectId,
      name: input.name,
      ...values,
    })
    .onConflict((conflict) => conflict.columns(['project_id', 'name']).doUpdateSet(values))
    .execute()
}

async function claimIncrementalSynchronization(
  lock: RepositoryLock,
  execution: RepositoryIncrementalSyncExecution,
): Promise<ClaimedIncrementalSynchronization | undefined> {
  return withRepositoryTransactionInLock(lock, async ({ transaction }) => {
    const request = await transaction
      .selectFrom('repository_incremental_sync_requests')
      .selectAll()
      .where('id', '=', execution.requestId)
      .forUpdate()
      .executeTakeFirst()

    if (!request || isTerminalStatus(request.status)) {
      return undefined
    }

    const project = await transaction
      .selectFrom('projects')
      .select([
        'id',
        'installation_id',
        'source_branch',
        'production_branch',
        'configuration_version',
        'status',
      ])
      .where('id', '=', request.project_id)
      .forUpdate()
      .executeTakeFirst()

    if (
      !project ||
      request.sync_type !== execution.syncType ||
      project.configuration_version !== request.configuration_version ||
      project.status === 'pending_deletion' ||
      project.status === 'deleted'
    ) {
      const now = new Date()

      await transaction
        .updateTable('repository_incremental_sync_requests')
        .set({
          status: 'superseded',
          completed_at: now,
          last_error_code: 'configuration_superseded',
          last_error_message: 'Project configuration changed before incremental synchronization',
          updated_at: now,
        })
        .where('id', '=', execution.requestId)
        .where('status', 'in', ['queued', 'running'])
        .execute()

      return undefined
    }

    const now = new Date()

    await transaction
      .updateTable('repository_incremental_sync_requests')
      .set({
        status: 'running',
        ...(request.status === 'queued' ? { claimed_at: now } : {}),
        attempt_count: execution.attempt,
        last_error_code: null,
        last_error_message: null,
        updated_at: now,
      })
      .where('id', '=', execution.requestId)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirstOrThrow()

    const scope = parseRepositoryIncrementalSyncScope(request.scope)

    return {
      requestId: request.id,
      projectId: request.project_id,
      repositoryId: request.repository_id,
      installationId: scope.installationId ?? project.installation_id,
      configurationVersion: request.configuration_version,
      syncType: request.sync_type,
      scope,
      sourceBranch: project.source_branch,
      productionBranch: project.production_branch,
    }
  })
}

async function markIncrementalSynchronizationSucceeded(
  database: DatabaseClient,
  claimed: ClaimedIncrementalSynchronization,
  now: Date,
): Promise<boolean> {
  return withRepositoryLock(database, claimed.repositoryId, (lock) =>
    withRepositoryTransactionInLock(lock, async ({ transaction }) => {
      const project = await transaction
        .selectFrom('projects')
        .select(['configuration_version', 'status'])
        .where('id', '=', claimed.projectId)
        .executeTakeFirst()

      if (
        !project ||
        project.configuration_version !== claimed.configurationVersion ||
        project.status === 'pending_deletion' ||
        project.status === 'deleted'
      ) {
        await transaction
          .updateTable('repository_incremental_sync_requests')
          .set({
            status: 'superseded',
            completed_at: now,
            last_error_code: 'configuration_superseded',
            last_error_message: 'Project changed while incremental synchronization was running',
            updated_at: now,
          })
          .where('id', '=', claimed.requestId)
          .where('status', '=', 'running')
          .execute()

        return false
      }

      const updated = await transaction
        .updateTable('repository_incremental_sync_requests')
        .set({
          status: 'succeeded',
          completed_at: now,
          last_error_code: null,
          last_error_message: null,
          updated_at: now,
        })
        .where('id', '=', claimed.requestId)
        .where('status', '=', 'running')
        .returning('id')
        .executeTakeFirst()

      return updated !== undefined
    }),
  )
}

async function recordIncrementalSynchronizationAttempt(
  database: DatabaseClient,
  claimed: ClaimedIncrementalSynchronization,
  input: { readonly code: string; readonly message: string; readonly attempt: number },
): Promise<void> {
  await database.kysely
    .updateTable('repository_incremental_sync_requests')
    .set({
      attempt_count: input.attempt,
      last_error_code: input.code,
      last_error_message: input.message,
      updated_at: new Date(),
    })
    .where('id', '=', claimed.requestId)
    .where('status', '=', 'running')
    .execute()
}

async function markIncrementalSynchronizationFailed(
  database: DatabaseClient,
  claimed: ClaimedIncrementalSynchronization,
  error: unknown,
  execution: RepositoryIncrementalSyncExecution,
): Promise<JsonValue> {
  const now = new Date()
  const code = errorCode(error)
  const message = toError(error).message
  const permissionProblem = isPermissionProblem(error)

  return withRepositoryLock(database, claimed.repositoryId, (lock) =>
    withRepositoryTransactionInLock(lock, async ({ transaction }) => {
      await transaction
        .updateTable('repository_incremental_sync_requests')
        .set({
          status: 'failed',
          attempt_count: execution.attempt,
          completed_at: now,
          last_error_code: code,
          last_error_message: message,
          updated_at: now,
        })
        .where('id', '=', claimed.requestId)
        .where('status', 'in', ['queued', 'running'])
        .execute()

      const project = await transaction
        .updateTable('projects')
        .set({ status: permissionProblem ? 'disconnected' : 'degraded', updated_at: now })
        .where('id', '=', claimed.projectId)
        .where('configuration_version', '=', claimed.configurationVersion)
        .where('status', 'in', ['initializing', 'active', 'degraded', 'disconnected'])
        .returning(['source_sha', 'production_sha'])
        .executeTakeFirst()

      let reconciliationRequestId: string | null = null

      if (!permissionProblem && project?.source_sha && project.production_sha) {
        const reconciliation = await queueRepositoryInitialSync({
          transaction,
          projectId: claimed.projectId,
          repositoryId: claimed.repositoryId,
          configurationVersion: claimed.configurationVersion,
          reason: 'incremental_sync_inconsistency',
          requestedByGitHubUserId: null,
          sourceSha: project.source_sha,
          productionSha: project.production_sha,
          idempotencyKey: [
            'incremental-sync-inconsistency',
            claimed.projectId,
            claimed.configurationVersion,
            claimed.requestId,
          ].join(':'),
          correlationId: execution.correlationId,
          causationId:
            execution.causationId ?? `repository-incremental-request:${claimed.requestId}:failed`,
          triggerScope: claimed.scope,
          now,
        })
        reconciliationRequestId = reconciliation.id
      }

      return {
        status: 'failed',
        requestId: claimed.requestId,
        code,
        projectStatus: permissionProblem ? 'disconnected' : 'degraded',
        reconciliationRequestId,
      }
    }),
  )
}

function firstReason(scope: RepositoryIncrementalSyncScope, fallback: string): string {
  return scope.reasons[0] ?? fallback
}

function primaryDeliveryId(scope: RepositoryIncrementalSyncScope): string | undefined {
  return scope.deliveryIds[0]
}

function isTerminalStatus(status: string): boolean {
  return status === 'succeeded' || status === 'superseded' || status === 'failed'
}

function isRetryable(value: unknown): boolean {
  if (value instanceof PermanentJobError) {
    return false
  }

  if (value instanceof RetryableJobError) {
    return true
  }

  if (value instanceof ProjectConfigurationValidationError) {
    return value.code === 'external_state_unknown' || value.code === 'repository_state_changed'
  }

  const status = httpStatus(value)
  return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500
}

function isPermissionProblem(value: unknown): boolean {
  if ((value instanceof PermanentJobError || value instanceof RetryableJobError) && value.cause) {
    return isPermissionProblem(value.cause)
  }

  if (value instanceof ProjectConfigurationValidationError) {
    return value.code === 'installation_unavailable' || value.code === 'repository_unavailable'
  }

  const status = httpStatus(value)
  return status === 401 || status === 403 || status === 404
}

function errorCode(value: unknown): string {
  if (value instanceof ProjectConfigurationValidationError) {
    return value.code
  }

  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = Reflect.get(value, 'code')
    if (typeof code === 'string' && code.length > 0) return code.toLowerCase()
  }

  const status = httpStatus(value)
  return status === undefined ? 'repository_incremental_sync_failed' : `github_http_${status}`
}

function httpStatus(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || !('status' in value)) return undefined
  const status = Reflect.get(value, 'status')
  return typeof status === 'number' ? status : undefined
}

function parseGitHubId(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Stored ${name} is outside JavaScript's safe integer range: ${value}`)
  }
  return parsed
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
