import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseSchema, JsonValue } from '@shipgate/database'
import type { GitHubAuthenticationService } from '@shipgate/github'
import {
  PermanentJobError,
  type RepositoryInitialSyncHandler,
  RetryableJobError,
} from '@shipgate/jobs'
import type { Selectable, Transaction } from 'kysely'

import { ProjectConfigurationValidationError } from './errors.js'
import type { ReadOnlyGitWorkspace } from './git-workspace.js'
import {
  buildRepositoryProjectionSnapshot,
  createProjectionFingerprint,
  loadRepositoryMetadata,
  type RepositoryHeadState,
  type RepositoryInitialSyncTarget,
  repositoryInitialSyncPermissions,
  resolveRepositoryHeads,
} from './initial-sync-github.js'
import {
  type RepositoryLock,
  withRepositoryLock,
  withRepositoryTransactionInLock,
} from './repository-transaction.js'
import { parseRequiredCheckOverrides } from './required-checks.js'
import {
  applyRepositoryProjectionInTransaction,
  validateRepositoryProjectionSnapshot,
} from './store.js'
import { queueRepositoryInitialSync } from './sync-queue.js'

interface ClaimedSynchronization {
  readonly requestId: string
  readonly syncRunId: string
  readonly projectId: string
  readonly repositoryId: string
  readonly installationId: string
  readonly configurationVersion: number
  readonly reason: string
  readonly idempotencyKey: string
  readonly sourceBranch: string
  readonly productionBranch: string
  readonly requestedSourceSha: string
  readonly requestedProductionSha: string
  readonly requiredCheckOverrides: ReturnType<typeof parseRequiredCheckOverrides>
}

export function createRepositoryInitialSyncHandler(options: {
  readonly database: DatabaseClient
  readonly githubAuth: GitHubAuthenticationService
  readonly gitWorkspace: ReadOnlyGitWorkspace
}): RepositoryInitialSyncHandler {
  return async (execution) => {
    const request = await options.database.kysely
      .selectFrom('repository_reconciliation_requests')
      .select(['id', 'repository_id', 'status'])
      .where('id', '=', execution.requestId)
      .executeTakeFirst()

    if (!request) {
      return { status: 'ignored', reason: 'request_not_found' }
    }

    if (isTerminalRequestStatus(request.status)) {
      return { status: request.status, requestId: request.id }
    }

    return withRepositoryLock(options.database, request.repository_id, async (lock) => {
      const claimed = await claimSynchronization(lock, execution.requestId, execution.attempt)

      if (!claimed) {
        return { status: 'ignored', reason: 'request_no_longer_runnable' }
      }

      try {
        return await executeSynchronization(options, lock, claimed, execution)
      } catch (error) {
        const retryable = isRetryableSyncError(error)

        if (retryable && execution.attempt < execution.maxAttempts) {
          execution.logger.warn(
            {
              event: 'repository.initial_sync.retrying',
              requestId: claimed.requestId,
              projectId: claimed.projectId,
              repositoryId: claimed.repositoryId,
              attempt: execution.attempt,
              error: toError(error),
            },
            'Repository initial synchronization will be retried',
          )

          throw new RetryableJobError('Repository initial synchronization failed temporarily', {
            code: getErrorCode(error),
            details: {
              requestId: claimed.requestId,
              projectId: claimed.projectId,
              attempt: execution.attempt,
            },
            cause: error,
          })
        }

        const result = await markSynchronizationFailed(lock, claimed, error, new Date())
        const code = getErrorCode(error)

        execution.logger.error(
          {
            event: 'repository.initial_sync.failed',
            requestId: claimed.requestId,
            projectId: claimed.projectId,
            repositoryId: claimed.repositoryId,
            attempt: execution.attempt,
            retryable,
            error: toError(error),
          },
          'Repository initial synchronization failed',
        )

        throw new PermanentJobError('Repository initial synchronization failed permanently', {
          code,
          details: result,
          cause: error,
        })
      }
    })
  }
}

async function executeSynchronization(
  options: {
    readonly database: DatabaseClient
    readonly githubAuth: GitHubAuthenticationService
    readonly gitWorkspace: ReadOnlyGitWorkspace
  },
  lock: RepositoryLock,
  claimed: ClaimedSynchronization,
  execution: Parameters<RepositoryInitialSyncHandler>[0],
): Promise<JsonValue> {
  const target = toTarget(claimed)
  const installationId = parseGitHubId(claimed.installationId, 'installation ID')
  const repositoryId = parseGitHubId(claimed.repositoryId, 'repository ID')
  const client = await options.githubAuth.getInstallationClient({
    installationId,
    repositoryIds: [repositoryId],
    permissions: repositoryInitialSyncPermissions,
  })
  const metadata = await loadRepositoryMetadata(client, repositoryId)
  const observedHeads = await resolveRepositoryHeads(
    client,
    metadata,
    claimed.sourceBranch,
    claimed.productionBranch,
  )

  if (
    claimed.requestedSourceSha !== observedHeads.sourceSha ||
    claimed.requestedProductionSha !== observedHeads.productionSha
  ) {
    return supersedeSynchronization({
      lock,
      claimed,
      finalHeads: observedHeads,
      correlationId: execution.correlationId,
      now: new Date(),
    })
  }

  if (!options.githubAuth.withInstallationToken) {
    throw new Error('GitHub authentication provider cannot lease an installation token')
  }

  const git = await options.githubAuth.withInstallationToken(
    {
      installationId,
      repositoryIds: [repositoryId],
      permissions: repositoryInitialSyncPermissions,
    },
    ({ token }) =>
      options.gitWorkspace.loadRepositorySnapshot({
        cloneUrl: metadata.cloneUrl,
        installationToken: token,
        sourceBranch: claimed.sourceBranch,
        productionBranch: claimed.productionBranch,
        sourceSha: observedHeads.sourceSha,
        productionSha: observedHeads.productionSha,
        signal: execution.signal,
      }),
  )
  const observedAt = new Date()
  const snapshot = await buildRepositoryProjectionSnapshot({
    client,
    target,
    metadata,
    heads: observedHeads,
    git,
    observedAt,
    requiredCheckOverrides: claimed.requiredCheckOverrides,
  })

  validateRepositoryProjectionSnapshot(snapshot)

  const finalHeads = await resolveRepositoryHeads(
    client,
    metadata,
    claimed.sourceBranch,
    claimed.productionBranch,
  )

  if (!sameHeads(observedHeads, finalHeads)) {
    return supersedeSynchronization({
      lock,
      claimed,
      finalHeads,
      correlationId: execution.correlationId,
      now: new Date(),
    })
  }

  const completedAt = new Date()
  const fingerprint = createProjectionFingerprint(snapshot)

  return withRepositoryTransactionInLock(lock, async (scope) => {
    const current = await scope.transaction
      .selectFrom('repository_reconciliation_requests as request')
      .innerJoin('projects as project', 'project.id', 'request.project_id')
      .select([
        'request.status',
        'request.configuration_version',
        'project.configuration_version as project_configuration_version',
        'project.status as project_status',
      ])
      .where('request.id', '=', claimed.requestId)
      .forUpdate()
      .executeTakeFirst()

    if (
      current?.status !== 'running' ||
      current.configuration_version !== claimed.configurationVersion ||
      current.project_configuration_version !== claimed.configurationVersion ||
      current.project_status === 'pending_deletion' ||
      current.project_status === 'deleted'
    ) {
      await markSupersededWithoutReplacement(
        scope.transaction,
        claimed,
        completedAt,
        'configuration_changed_during_synchronization',
      )
      return { status: 'superseded', requestId: claimed.requestId }
    }

    const applied = await applyRepositoryProjectionInTransaction(scope, {
      projectId: claimed.projectId,
      syncRunId: claimed.syncRunId,
      repositoryId: claimed.repositoryId,
      expectedConfigurationVersion: claimed.configurationVersion,
      reason: claimed.reason,
      idempotencyKey: claimed.idempotencyKey,
      projectionFingerprint: fingerprint,
      startedAt: observedAt,
      completedAt,
      snapshot,
    })

    await scope.transaction
      .updateTable('repository_reconciliation_requests')
      .set({
        status: 'succeeded',
        source_sha: observedHeads.sourceSha,
        production_sha: observedHeads.productionSha,
        completed_at: completedAt,
        last_error_code: null,
        last_error_message: null,
        updated_at: completedAt,
      })
      .where('id', '=', claimed.requestId)
      .where('status', '=', 'running')
      .executeTakeFirstOrThrow()

    return {
      status: applied.status,
      requestId: claimed.requestId,
      syncRunId: applied.syncRunId,
      projectId: claimed.projectId,
      sourceSha: observedHeads.sourceSha,
      productionSha: observedHeads.productionSha,
      configurationVersion: claimed.configurationVersion,
    }
  })
}

async function claimSynchronization(
  lock: RepositoryLock,
  requestId: string,
  attempt: number,
): Promise<ClaimedSynchronization | undefined> {
  return withRepositoryTransactionInLock(lock, async ({ transaction }) => {
    const row = await transaction
      .selectFrom('repository_reconciliation_requests as request')
      .innerJoin('projects as project', 'project.id', 'request.project_id')
      .select([
        'request.id',
        'request.sync_run_id',
        'request.project_id',
        'request.repository_id',
        'request.configuration_version',
        'request.reason',
        'request.idempotency_key',
        'request.source_sha',
        'request.production_sha',
        'request.status',
        'project.installation_id',
        'project.source_branch',
        'project.production_branch',
        'project.required_check_overrides',
        'project.configuration_version as project_configuration_version',
        'project.status as project_status',
      ])
      .where('request.id', '=', requestId)
      .forUpdate()
      .executeTakeFirst()

    if (!row || isTerminalRequestStatus(row.status)) {
      return undefined
    }

    if (
      row.project_configuration_version !== row.configuration_version ||
      row.project_status === 'pending_deletion' ||
      row.project_status === 'deleted'
    ) {
      await markSupersededWithoutReplacement(
        transaction,
        mapClaimed(row),
        new Date(),
        'configuration_changed_before_synchronization',
      )
      return undefined
    }

    const now = new Date()

    await transaction
      .updateTable('repository_reconciliation_requests')
      .set({
        status: 'running',
        ...(row.status === 'queued' ? { claimed_at: now } : {}),
        attempt_count: attempt,
        updated_at: now,
      })
      .where('id', '=', requestId)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirstOrThrow()

    await transaction
      .updateTable('repository_sync_runs')
      .set({
        status: 'running',
        ...(row.status === 'queued' ? { started_at: now } : {}),
      })
      .where('id', '=', row.sync_run_id)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirstOrThrow()

    return mapClaimed(row)
  })
}

async function supersedeSynchronization(input: {
  readonly lock: RepositoryLock
  readonly claimed: ClaimedSynchronization
  readonly finalHeads: RepositoryHeadState
  readonly correlationId: string
  readonly now: Date
}): Promise<JsonValue> {
  return withRepositoryTransactionInLock(input.lock, async ({ transaction }) => {
    const current = await transaction
      .selectFrom('repository_reconciliation_requests as request')
      .innerJoin('projects as project', 'project.id', 'request.project_id')
      .select([
        'request.status',
        'project.configuration_version',
        'project.status as project_status',
      ])
      .where('request.id', '=', input.claimed.requestId)
      .forUpdate()
      .executeTakeFirst()

    if (!current || isTerminalRequestStatus(current.status)) {
      return { status: current?.status ?? 'ignored', requestId: input.claimed.requestId }
    }

    if (
      current.configuration_version !== input.claimed.configurationVersion ||
      current.project_status === 'pending_deletion' ||
      current.project_status === 'deleted'
    ) {
      await markSupersededWithoutReplacement(
        transaction,
        input.claimed,
        input.now,
        'configuration_changed_during_synchronization',
      )
      return { status: 'superseded', requestId: input.claimed.requestId }
    }

    const replacement = await queueRepositoryInitialSync({
      transaction,
      projectId: input.claimed.projectId,
      repositoryId: input.claimed.repositoryId,
      configurationVersion: input.claimed.configurationVersion,
      reason: 'branch_heads_changed_during_synchronization',
      requestedByGitHubUserId: null,
      sourceSha: input.finalHeads.sourceSha,
      productionSha: input.finalHeads.productionSha,
      idempotencyKey: [
        'repository-heads',
        input.claimed.projectId,
        input.claimed.configurationVersion,
        input.finalHeads.sourceSha,
        input.finalHeads.productionSha,
      ].join(':'),
      correlationId: input.correlationId,
      causationId: `repository-sync:${input.claimed.requestId}:superseded`,
      now: input.now,
    })

    await transaction
      .updateTable('repository_reconciliation_requests')
      .set({
        status: 'superseded',
        superseded_by_request_id: replacement.id,
        completed_at: input.now,
        last_error_code: 'synchronization_superseded',
        last_error_message: 'Branch heads changed while the snapshot was being built',
        updated_at: input.now,
      })
      .where('id', '=', input.claimed.requestId)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirstOrThrow()

    await transaction
      .updateTable('repository_sync_runs')
      .set({
        status: 'superseded',
        completed_at: input.now,
        error_code: 'synchronization_superseded',
        error_message: 'Branch heads changed while the snapshot was being built',
      })
      .where('id', '=', input.claimed.syncRunId)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirstOrThrow()

    return {
      status: 'superseded',
      requestId: input.claimed.requestId,
      replacementRequestId: replacement.id,
      sourceSha: input.finalHeads.sourceSha,
      productionSha: input.finalHeads.productionSha,
    }
  })
}

async function markSynchronizationFailed(
  lock: RepositoryLock,
  claimed: ClaimedSynchronization,
  error: unknown,
  now: Date,
): Promise<JsonValue> {
  const code = getErrorCode(error)
  const message = toError(error).message
  const disconnected = isDisconnectedError(error)

  return withRepositoryTransactionInLock(lock, async ({ transaction }) => {
    const request = await transaction
      .selectFrom('repository_reconciliation_requests')
      .select('status')
      .where('id', '=', claimed.requestId)
      .forUpdate()
      .executeTakeFirst()

    if (!request || isTerminalRequestStatus(request.status)) {
      return { status: request?.status ?? 'ignored', requestId: claimed.requestId }
    }

    await transaction
      .updateTable('repository_reconciliation_requests')
      .set({
        status: 'failed',
        completed_at: now,
        last_error_code: code,
        last_error_message: message,
        updated_at: now,
      })
      .where('id', '=', claimed.requestId)
      .execute()

    await transaction
      .updateTable('repository_sync_runs')
      .set({
        status: 'failed',
        completed_at: now,
        error_code: code,
        error_message: message,
      })
      .where('id', '=', claimed.syncRunId)
      .where('status', 'in', ['queued', 'running'])
      .execute()

    await transaction
      .insertInto('repository_sync_issues')
      .values({
        id: randomUUID(),
        sync_run_id: claimed.syncRunId,
        project_id: claimed.projectId,
        repository_id: claimed.repositoryId,
        severity: 'error',
        code,
        scope: 'repository',
        subject_id: null,
        message,
        details: JSON.stringify({ requestId: claimed.requestId }),
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute()

    await transaction
      .updateTable('projects')
      .set({ status: disconnected ? 'disconnected' : 'degraded', updated_at: now })
      .where('id', '=', claimed.projectId)
      .where('configuration_version', '=', claimed.configurationVersion)
      .where('status', 'in', ['initializing', 'active', 'degraded', 'disconnected'])
      .execute()

    return {
      status: 'failed',
      requestId: claimed.requestId,
      syncRunId: claimed.syncRunId,
      code,
      projectStatus: disconnected ? 'disconnected' : 'degraded',
    }
  })
}

async function markSupersededWithoutReplacement(
  transaction: Transaction<DatabaseSchema>,
  claimed: ClaimedSynchronization,
  now: Date,
  message: string,
): Promise<void> {
  await transaction
    .updateTable('repository_reconciliation_requests')
    .set({
      status: 'superseded',
      completed_at: now,
      last_error_code: 'synchronization_superseded',
      last_error_message: message,
      updated_at: now,
    })
    .where('id', '=', claimed.requestId)
    .where('status', 'in', ['queued', 'running'])
    .execute()

  await transaction
    .updateTable('repository_sync_runs')
    .set({
      status: 'superseded',
      completed_at: now,
      error_code: 'synchronization_superseded',
      error_message: message,
    })
    .where('id', '=', claimed.syncRunId)
    .where('status', 'in', ['queued', 'running'])
    .execute()
}

function mapClaimed(row: {
  readonly id: string
  readonly sync_run_id: string
  readonly project_id: string
  readonly repository_id: string
  readonly configuration_version: number
  readonly reason: string
  readonly idempotency_key: string
  readonly source_sha: string
  readonly production_sha: string
  readonly installation_id: string
  readonly source_branch: string
  readonly production_branch: string
  readonly required_check_overrides: unknown
}): ClaimedSynchronization {
  return {
    requestId: row.id,
    syncRunId: row.sync_run_id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    installationId: row.installation_id,
    configurationVersion: row.configuration_version,
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
    sourceBranch: row.source_branch,
    productionBranch: row.production_branch,
    requestedSourceSha: row.source_sha,
    requestedProductionSha: row.production_sha,
    requiredCheckOverrides: parseRequiredCheckOverrides(row.required_check_overrides),
  }
}

function toTarget(claimed: ClaimedSynchronization): RepositoryInitialSyncTarget {
  return {
    installationId: parseGitHubId(claimed.installationId, 'installation ID'),
    repositoryId: parseGitHubId(claimed.repositoryId, 'repository ID'),
    configurationVersion: claimed.configurationVersion,
    sourceBranch: claimed.sourceBranch,
    productionBranch: claimed.productionBranch,
  }
}

function sameHeads(left: RepositoryHeadState, right: RepositoryHeadState): boolean {
  return left.sourceSha === right.sourceSha && left.productionSha === right.productionSha
}

function isTerminalRequestStatus(
  status: Selectable<DatabaseSchema['repository_reconciliation_requests']>['status'],
): boolean {
  return ['succeeded', 'superseded', 'failed', 'cancelled'].includes(status)
}

function isRetryableSyncError(value: unknown): boolean {
  if (value instanceof ProjectConfigurationValidationError) {
    return value.code === 'repository_state_changed' || value.code === 'external_state_unknown'
  }

  const status = getHttpStatus(value)
  return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500
}

function isDisconnectedError(value: unknown): boolean {
  if (value instanceof ProjectConfigurationValidationError) {
    return value.code === 'installation_unavailable' || value.code === 'repository_unavailable'
  }

  const status = getHttpStatus(value)
  return status === 401 || status === 403 || status === 404
}

function getErrorCode(value: unknown): string {
  if (value instanceof ProjectConfigurationValidationError) {
    return value.code
  }

  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = Reflect.get(value, 'code')

    if (typeof code === 'string' && code.length > 0) {
      return code.toLowerCase()
    }
  }

  const status = getHttpStatus(value)
  return status === undefined ? 'repository_initial_sync_failed' : `github_http_${status}`
}

function getHttpStatus(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    return undefined
  }

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
