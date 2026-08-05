import { randomUUID } from 'node:crypto'

import { type DatabaseClient, type DatabaseSchema, withTransaction } from '@shipgate/database'
import { enqueueJobInTransaction } from '@shipgate/jobs'
import { type Selectable, sql, type Transaction } from 'kysely'
import {
  mergeRepositoryIncrementalSyncScopes,
  normalizeRepositoryIncrementalSyncScope,
  parseRepositoryIncrementalSyncScope,
  type RepositoryIncrementalSyncScope,
} from './incremental-sync-queue.js'
import type { ReconciliationRequestRecord } from './model.js'
import { withRepositoryTransaction } from './repository-transaction.js'

export interface QueueRepositorySyncInput {
  readonly transaction: Transaction<DatabaseSchema>
  readonly projectId: string
  readonly repositoryId: string
  readonly configurationVersion: number
  readonly reason: string
  readonly requestedByGitHubUserId: string | null
  readonly sourceSha: string
  readonly productionSha: string
  readonly idempotencyKey: string
  readonly correlationId: string
  readonly causationId: string
  readonly now: Date
  readonly triggerScope?: Partial<RepositoryIncrementalSyncScope>
  readonly forcePush?: boolean
}

export interface QueueRepositoryReconciliationForProjectInput {
  readonly projectId: string
  readonly reason: string
  readonly requestedByGitHubUserId: string | null
  readonly deduplicationKey: string
  readonly correlationId: string
  readonly causationId: string
  readonly now?: Date
  readonly triggerScope?: Partial<RepositoryIncrementalSyncScope>
  readonly forcePush?: boolean
}

export interface QueueDueRepositoryReconciliationsInput {
  readonly intervalMs: number
  readonly now?: Date
  readonly limit?: number
}

export async function queueRepositoryInitialSync(
  input: QueueRepositorySyncInput,
): Promise<ReconciliationRequestRecord> {
  const project = await input.transaction
    .selectFrom('projects')
    .select(['id', 'repository_id', 'configuration_version', 'status'])
    .where('id', '=', input.projectId)
    .forUpdate()
    .executeTakeFirstOrThrow()

  if (
    project.repository_id !== input.repositoryId ||
    project.configuration_version !== input.configurationVersion ||
    project.status === 'pending_deletion' ||
    project.status === 'deleted'
  ) {
    throw new Error(`Project ${input.projectId} cannot queue repository reconciliation`)
  }

  const queued = await input.transaction
    .selectFrom('repository_reconciliation_requests')
    .selectAll()
    .where('repository_id', '=', input.repositoryId)
    .where('status', '=', 'queued')
    .orderBy('requested_at')
    .forUpdate()
    .executeTakeFirst()

  if (
    queued &&
    queued.project_id === input.projectId &&
    queued.configuration_version === input.configurationVersion
  ) {
    const triggerScope = mergeRepositoryIncrementalSyncScopes(
      parseRepositoryIncrementalSyncScope(queued.trigger_scope),
      normalizeRepositoryIncrementalSyncScope(input.triggerScope ?? {}),
    )
    const updated = await input.transaction
      .updateTable('repository_reconciliation_requests')
      .set({
        source_sha: input.sourceSha,
        production_sha: input.productionSha,
        trigger_scope: JSON.stringify(triggerScope),
        force_push: queued.force_push || input.forcePush === true,
        coalesced_count: queued.coalesced_count + 1,
        updated_at: input.now,
      })
      .where('id', '=', queued.id)
      .where('status', '=', 'queued')
      .returningAll()
      .executeTakeFirstOrThrow()

    await input.transaction
      .updateTable('repository_sync_runs')
      .set({ source_sha: input.sourceSha, production_sha: input.productionSha })
      .where('id', '=', queued.sync_run_id)
      .where('status', '=', 'queued')
      .executeTakeFirstOrThrow()

    return mapReconciliation(updated)
  }

  if (queued) {
    await supersedeQueuedReconciliation(
      input.transaction,
      queued,
      input.now,
      'Project configuration changed before queued reconciliation started',
    )
  }

  const existing = await input.transaction
    .selectFrom('repository_reconciliation_requests')
    .selectAll()
    .where('project_id', '=', input.projectId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst()

  if (existing) {
    assertSameRequest(existing, input)
    return mapReconciliation(existing)
  }

  const requestId = randomUUID()
  const syncRunId = randomUUID()

  await input.transaction
    .insertInto('repository_sync_runs')
    .values({
      id: syncRunId,
      project_id: input.projectId,
      repository_id: input.repositoryId,
      reason: input.reason,
      status: 'queued',
      configuration_version: input.configurationVersion,
      idempotency_key: input.idempotencyKey,
      projection_fingerprint: null,
      source_sha: input.sourceSha,
      production_sha: input.productionSha,
      started_at: input.now,
      completed_at: null,
      error_code: null,
      error_message: null,
    })
    .execute()

  const row = await input.transaction
    .insertInto('repository_reconciliation_requests')
    .values({
      id: requestId,
      sync_run_id: syncRunId,
      project_id: input.projectId,
      repository_id: input.repositoryId,
      configuration_version: input.configurationVersion,
      reason: input.reason,
      mode: 'full',
      status: 'queued',
      requested_by_github_user_id: input.requestedByGitHubUserId,
      source_sha: input.sourceSha,
      production_sha: input.productionSha,
      idempotency_key: input.idempotencyKey,
      superseded_by_request_id: null,
      attempt_count: 0,
      last_error_code: null,
      last_error_message: null,
      requested_at: input.now,
      claimed_at: null,
      completed_at: null,
      trigger_scope: JSON.stringify(
        normalizeRepositoryIncrementalSyncScope(input.triggerScope ?? {}),
      ),
      force_push: input.forcePush === true,
      coalesced_count: 0,
      updated_at: input.now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  await enqueueRepositoryInitialSyncJob(input.transaction, requestId, {
    correlationId: input.correlationId,
    causationId: input.causationId,
  })

  return mapReconciliation(row)
}

export async function queueRepositoryReconciliationForProject(
  database: DatabaseClient,
  input: QueueRepositoryReconciliationForProjectInput,
): Promise<ReconciliationRequestRecord | null> {
  if (input.deduplicationKey.trim().length === 0) {
    throw new TypeError('Repository reconciliation deduplication key must not be empty')
  }

  const locator = await database.kysely
    .selectFrom('projects')
    .select('repository_id')
    .where('id', '=', input.projectId)
    .executeTakeFirst()

  if (!locator) {
    return null
  }

  return withRepositoryTransaction(database, locator.repository_id, async ({ transaction }) => {
    const project = await transaction
      .selectFrom('projects')
      .select([
        'id',
        'repository_id',
        'configuration_version',
        'status',
        'source_sha',
        'production_sha',
      ])
      .where('id', '=', input.projectId)
      .forUpdate()
      .executeTakeFirst()

    if (
      !project ||
      project.repository_id !== locator.repository_id ||
      project.status === 'pending_deletion' ||
      project.status === 'deleted' ||
      project.source_sha === null ||
      project.production_sha === null
    ) {
      return null
    }

    const now = input.now ?? new Date()
    const triggerScope = {
      ...input.triggerScope,
      reasons: [...(input.triggerScope?.reasons ?? []), input.reason],
    }

    return queueRepositoryInitialSync({
      transaction,
      projectId: project.id,
      repositoryId: project.repository_id,
      configurationVersion: project.configuration_version,
      reason: input.reason,
      requestedByGitHubUserId: input.requestedByGitHubUserId,
      sourceSha: project.source_sha,
      productionSha: project.production_sha,
      idempotencyKey: [
        reconciliationIdempotencyPrefix(input.reason),
        project.id,
        project.configuration_version,
        input.deduplicationKey,
      ].join(':'),
      correlationId: input.correlationId,
      causationId: input.causationId,
      triggerScope,
      ...(input.forcePush !== undefined ? { forcePush: input.forcePush } : {}),
      now,
    })
  })
}

export async function queueDueRepositoryReconciliations(
  database: DatabaseClient,
  input: QueueDueRepositoryReconciliationsInput,
): Promise<number> {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 60_000) {
    throw new RangeError('Repository reconciliation interval must be at least 60000ms')
  }

  const limit = input.limit ?? 100

  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new RangeError('Repository reconciliation batch limit must be between 1 and 1000')
  }

  const now = input.now ?? new Date()
  const cutoff = new Date(now.getTime() - input.intervalMs)
  const bucket = Math.floor(now.getTime() / input.intervalMs)
  const candidates = await sql<{ readonly project_id: string }>`
    select project.id as project_id
    from projects as project
    where project.status in ('initializing', 'active', 'degraded', 'disconnected')
      and project.source_sha is not null
      and project.production_sha is not null
      and (
        project.last_successful_sync_at is null
        or project.last_successful_sync_at <= ${cutoff}
      )
      and not exists (
        select 1
        from repository_reconciliation_requests as request
        where request.project_id = project.id
          and request.status in ('queued', 'running')
      )
    order by project.last_successful_sync_at nulls first, project.updated_at
    limit ${limit}
  `.execute(database.kysely)
  let queued = 0

  for (const candidate of candidates.rows) {
    const reconciliation = await queueRepositoryReconciliationForProject(database, {
      projectId: candidate.project_id,
      reason: 'periodic_reconciliation',
      requestedByGitHubUserId: null,
      deduplicationKey: String(bucket),
      correlationId: `repository.reconcile:periodic:${candidate.project_id}:${bucket}`,
      causationId: `scheduler:repository-reconciliation:${bucket}`,
      triggerScope: { reasons: ['periodic_reconciliation'] },
      now,
    })

    if (reconciliation && ['queued', 'running'].includes(reconciliation.status)) {
      queued += 1
    }
  }

  return queued
}

export async function recoverRepositoryInitialSyncJobs(database: DatabaseClient): Promise<number> {
  const topologyUpgradeProjects = await sql<{
    readonly project_id: string
    readonly repository_id: string
    readonly configuration_version: number
    readonly source_sha: string
    readonly production_sha: string
  }>`
    select
      project.id as project_id,
      project.repository_id,
      project.configuration_version,
      project.source_sha,
      project.production_sha
    from projects as project
    where project.status = 'degraded'
      and project.last_successful_sync_at is not null
      and project.source_sha is not null
      and project.production_sha is not null
      and not exists (
        select 1
        from repository_commits as commit
        where commit.project_id = project.id
          and commit.source_delta_position is not null
      )
      and not exists (
        select 1
        from repository_reconciliation_requests as request
        where request.project_id = project.id
          and request.idempotency_key =
            'commit-topology-upgrade:' || project.id || ':' ||
            project.configuration_version::text || ':' || project.source_sha || ':' ||
            project.production_sha
      )
    order by project.updated_at
  `.execute(database.kysely)
  let topologyUpgradeCount = 0

  for (const project of topologyUpgradeProjects.rows) {
    const reconciliation = await queueRepositoryReconciliationForProject(database, {
      projectId: project.project_id,
      reason: 'commit_topology_upgrade',
      requestedByGitHubUserId: null,
      deduplicationKey: `${project.source_sha}:${project.production_sha}`,
      correlationId: `repository.reconcile:topology-upgrade:${project.project_id}`,
      causationId: `project:${project.project_id}:commit-topology-upgrade`,
      triggerScope: { reasons: ['commit_topology_upgrade'] },
    })

    if (reconciliation && ['queued', 'running'].includes(reconciliation.status)) {
      topologyUpgradeCount += 1
    }
  }

  const recoveredJobs = await withTransaction(
    database.kysely,
    async (transaction: Transaction<DatabaseSchema>) => {
      const result = await sql<{ readonly request_id: string }>`
        select request.id as request_id
        from repository_reconciliation_requests as request
        left join graphile_worker.jobs as job
          on job.key in (
            'repository.reconcile:' || request.id,
            'repository.initial-sync:' || request.id
          )
        where request.status in ('queued', 'running')
          and job.id is null
        order by request.requested_at
        for update of request skip locked
      `.execute(transaction)

      for (const row of result.rows) {
        await enqueueRepositoryInitialSyncJob(transaction, row.request_id, {
          correlationId: `repository.reconcile:recovery:${row.request_id}`,
          causationId: `repository-sync-request:${row.request_id}:recovered`,
        })
      }

      return result.rows.length
    },
    { operation: 'projects.repository-reconciliation.recover' },
  )

  return topologyUpgradeCount + recoveredJobs
}

async function supersedeQueuedReconciliation(
  transaction: Transaction<DatabaseSchema>,
  request: Pick<
    Selectable<DatabaseSchema['repository_reconciliation_requests']>,
    'id' | 'sync_run_id'
  >,
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
    .where('id', '=', request.id)
    .where('status', '=', 'queued')
    .executeTakeFirstOrThrow()

  await transaction
    .updateTable('repository_sync_runs')
    .set({
      status: 'superseded',
      completed_at: now,
      error_code: 'synchronization_superseded',
      error_message: message,
    })
    .where('id', '=', request.sync_run_id)
    .where('status', '=', 'queued')
    .executeTakeFirstOrThrow()
}

function reconciliationIdempotencyPrefix(reason: string): string {
  return reason === 'commit_topology_upgrade' ? 'commit-topology-upgrade' : reason
}

async function enqueueRepositoryInitialSyncJob(
  transaction: Transaction<DatabaseSchema>,
  requestId: string,
  metadata: {
    readonly correlationId: string
    readonly causationId: string
  },
): Promise<void> {
  await enqueueJobInTransaction(
    transaction,
    'repository.reconcile',
    { requestId },
    {
      correlationId: metadata.correlationId,
      causationId: metadata.causationId,
      jobKey: `repository.reconcile:${requestId}`,
    },
  )
}

function assertSameRequest(
  existing: Selectable<DatabaseSchema['repository_reconciliation_requests']>,
  input: QueueRepositorySyncInput,
): void {
  if (
    existing.repository_id !== input.repositoryId ||
    existing.configuration_version !== input.configurationVersion ||
    existing.source_sha !== input.sourceSha ||
    existing.production_sha !== input.productionSha ||
    existing.reason !== input.reason
  ) {
    throw new Error(
      `Repository synchronization idempotency key ${input.idempotencyKey} was reused with different input`,
    )
  }
}

export function mapReconciliation(
  row: Selectable<DatabaseSchema['repository_reconciliation_requests']>,
): ReconciliationRequestRecord {
  return {
    id: row.id,
    syncRunId: row.sync_run_id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    configurationVersion: row.configuration_version,
    reason: row.reason,
    mode: row.mode,
    status: row.status,
    sourceSha: row.source_sha,
    productionSha: row.production_sha,
    requestedAt: row.requested_at,
  }
}
