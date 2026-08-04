import { randomUUID } from 'node:crypto'

import { type DatabaseClient, type DatabaseSchema, withTransaction } from '@shipgate/database'
import { enqueueJobInTransaction } from '@shipgate/jobs'
import { type Selectable, sql, type Transaction } from 'kysely'

import type { ReconciliationRequestRecord } from './model.js'

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
}

export async function queueRepositoryInitialSync(
  input: QueueRepositorySyncInput,
): Promise<ReconciliationRequestRecord> {
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

export async function recoverRepositoryInitialSyncJobs(database: DatabaseClient): Promise<number> {
  return withTransaction(
    database.kysely,
    async (transaction: Transaction<DatabaseSchema>) => {
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
        for update of project skip locked
      `.execute(transaction)

      for (const project of topologyUpgradeProjects.rows) {
        await queueRepositoryInitialSync({
          transaction,
          projectId: project.project_id,
          repositoryId: project.repository_id,
          configurationVersion: project.configuration_version,
          reason: 'commit_topology_upgrade',
          requestedByGitHubUserId: null,
          sourceSha: project.source_sha,
          productionSha: project.production_sha,
          idempotencyKey: [
            'commit-topology-upgrade',
            project.project_id,
            project.configuration_version,
            project.source_sha,
            project.production_sha,
          ].join(':'),
          correlationId: `repository.initial-sync:topology-upgrade:${project.project_id}`,
          causationId: `project:${project.project_id}:commit-topology-upgrade`,
          now: new Date(),
        })
      }

      const result = await sql<{ readonly request_id: string }>`
        select request.id as request_id
        from repository_reconciliation_requests as request
        left join graphile_worker.jobs as job
          on job.key = 'repository.initial-sync:' || request.id
        where request.status in ('queued', 'running')
          and job.id is null
        order by request.requested_at
        for update of request skip locked
      `.execute(transaction)

      for (const row of result.rows) {
        await enqueueRepositoryInitialSyncJob(transaction, row.request_id, {
          correlationId: `repository.initial-sync:recovery:${row.request_id}`,
          causationId: `repository-sync-request:${row.request_id}:recovered`,
        })
      }

      return topologyUpgradeProjects.rows.length + result.rows.length
    },
    { operation: 'projects.repository-initial-sync.recover' },
  )
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
    'repository.initial-sync',
    { requestId },
    {
      correlationId: metadata.correlationId,
      causationId: metadata.causationId,
      jobKey: `repository.initial-sync:${requestId}`,
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
