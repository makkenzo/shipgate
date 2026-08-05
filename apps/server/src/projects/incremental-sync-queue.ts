import { randomUUID } from 'node:crypto'

import type {
  DatabaseClient,
  DatabaseSchema,
  JsonValue,
  RepositoryIncrementalSyncType,
} from '@shipgate/database'
import { enqueueJobInTransaction } from '@shipgate/jobs'
import { type Selectable, sql, type Transaction } from 'kysely'

export interface RepositoryIncrementalSyncScope {
  readonly reasons: readonly string[]
  readonly installationId: string | null
  readonly deliveryIds: readonly string[]
  readonly branchNames: readonly string[]
  readonly pullRequestNumbers: readonly number[]
  readonly commitShas: readonly string[]
  readonly beforeShas: readonly string[]
  readonly afterShas: readonly string[]
  readonly forced: boolean
  readonly refreshMetadata: boolean
  readonly requireReconciliation: boolean
}

export interface RepositoryIncrementalSyncRequestRecord {
  readonly id: string
  readonly projectId: string
  readonly repositoryId: string
  readonly configurationVersion: number
  readonly syncType: RepositoryIncrementalSyncType
  readonly status: 'queued' | 'running' | 'succeeded' | 'superseded' | 'failed'
  readonly scope: RepositoryIncrementalSyncScope
  readonly requestedAt: Date
}

export interface QueueRepositoryIncrementalSyncInput {
  readonly transaction: Transaction<DatabaseSchema>
  readonly projectId: string
  readonly repositoryId: string
  readonly configurationVersion: number
  readonly syncType: RepositoryIncrementalSyncType
  readonly scope: Partial<RepositoryIncrementalSyncScope>
  readonly correlationId: string
  readonly causationId: string
  readonly now?: Date
}

export async function queueRepositoryIncrementalSync(
  input: QueueRepositoryIncrementalSyncInput,
): Promise<RepositoryIncrementalSyncRequestRecord | null> {
  const now = input.now ?? new Date()

  await acquireIncrementalSyncIntentLock(input.transaction, input.repositoryId, input.syncType)

  const existing = await input.transaction
    .selectFrom('repository_incremental_sync_requests')
    .selectAll()
    .where('repository_id', '=', input.repositoryId)
    .where('sync_type', '=', input.syncType)
    .where('status', '=', 'queued')
    .forUpdate()
    .executeTakeFirst()
  const project = await input.transaction
    .selectFrom('projects')
    .select(['id', 'repository_id', 'configuration_version', 'status'])
    .where('id', '=', input.projectId)
    .forUpdate()
    .executeTakeFirst()

  if (
    !project ||
    project.repository_id !== input.repositoryId ||
    project.configuration_version !== input.configurationVersion ||
    project.status === 'pending_deletion' ||
    project.status === 'deleted'
  ) {
    return null
  }

  const normalized = normalizeRepositoryIncrementalSyncScope(input.scope)

  if (existing) {
    if (
      existing.project_id !== input.projectId ||
      existing.configuration_version !== input.configurationVersion
    ) {
      await input.transaction
        .updateTable('repository_incremental_sync_requests')
        .set({
          status: 'superseded',
          completed_at: now,
          last_error_code: 'configuration_superseded',
          last_error_message: 'Project configuration changed before incremental synchronization',
          updated_at: now,
        })
        .where('id', '=', existing.id)
        .where('status', '=', 'queued')
        .execute()
    } else {
      const scope = mergeRepositoryIncrementalSyncScopes(
        parseRepositoryIncrementalSyncScope(existing.scope),
        normalized,
      )
      const row = await input.transaction
        .updateTable('repository_incremental_sync_requests')
        .set({ scope: JSON.stringify(scope), updated_at: now })
        .where('id', '=', existing.id)
        .where('status', '=', 'queued')
        .returningAll()
        .executeTakeFirstOrThrow()

      return mapRequest(row)
    }
  }

  const requestId = randomUUID()
  const row = await input.transaction
    .insertInto('repository_incremental_sync_requests')
    .values({
      id: requestId,
      project_id: input.projectId,
      repository_id: input.repositoryId,
      configuration_version: input.configurationVersion,
      sync_type: input.syncType,
      status: 'queued',
      scope: JSON.stringify(normalized),
      attempt_count: 0,
      last_error_code: null,
      last_error_message: null,
      requested_at: now,
      claimed_at: null,
      completed_at: null,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  await enqueueRepositoryIncrementalSyncJob(input.transaction, row, {
    correlationId: input.correlationId,
    causationId: input.causationId,
  })

  return mapRequest(row)
}

export interface RecoveredRepositoryIncrementalSyncProject {
  readonly projectId: string
  readonly repositoryId: string
  readonly configurationVersion: number
  readonly requestIds: readonly string[]
}

export async function recoverRepositoryIncrementalSyncJobs(
  database: DatabaseClient,
): Promise<readonly RecoveredRepositoryIncrementalSyncProject[]> {
  return database.kysely.transaction().execute(async (transaction) => {
    const result = await sql<{
      readonly id: string
      readonly project_id: string
      readonly repository_id: string
      readonly configuration_version: number
      readonly sync_type: RepositoryIncrementalSyncType
    }>`
      select
        request.id,
        request.project_id,
        request.repository_id,
        request.configuration_version,
        request.sync_type
      from repository_incremental_sync_requests as request
      left join graphile_worker.jobs as job
        on job.key = 'repository.incremental:' || request.id
      where request.status in ('queued', 'running')
        and job.id is null
      order by request.requested_at
    `.execute(transaction)

    const recoveredProjects = new Map<
      string,
      {
        readonly projectId: string
        readonly repositoryId: string
        readonly configurationVersion: number
        readonly requestIds: Set<string>
      }
    >()

    for (const candidate of result.rows) {
      await acquireIncrementalSyncIntentLock(
        transaction,
        candidate.repository_id,
        candidate.sync_type,
      )
      const request = await transaction
        .selectFrom('repository_incremental_sync_requests')
        .selectAll()
        .where('id', '=', candidate.id)
        .forUpdate()
        .executeTakeFirst()

      if (!request || (request.status !== 'queued' && request.status !== 'running')) {
        continue
      }

      const recoveredRequestIds = [request.id]
      let runnableRequest = request

      if (request.status === 'running') {
        const pending = await transaction
          .selectFrom('repository_incremental_sync_requests')
          .selectAll()
          .where('repository_id', '=', request.repository_id)
          .where('sync_type', '=', request.sync_type)
          .where('status', '=', 'queued')
          .where('id', '<>', request.id)
          .forUpdate()
          .executeTakeFirst()
        const now = new Date()

        if (pending) {
          const scope = mergeRepositoryIncrementalSyncScopes(
            parseRepositoryIncrementalSyncScope(request.scope),
            parseRepositoryIncrementalSyncScope(pending.scope),
          )
          runnableRequest = await transaction
            .updateTable('repository_incremental_sync_requests')
            .set({ scope: JSON.stringify(scope), updated_at: now })
            .where('id', '=', pending.id)
            .where('status', '=', 'queued')
            .returningAll()
            .executeTakeFirstOrThrow()
          await transaction
            .updateTable('repository_incremental_sync_requests')
            .set({
              status: 'superseded',
              completed_at: now,
              last_error_code: 'worker_recovery_coalesced',
              last_error_message: 'Recovered running request was merged into a pending request',
              updated_at: now,
            })
            .where('id', '=', request.id)
            .where('status', '=', 'running')
            .executeTakeFirstOrThrow()
          recoveredRequestIds.push(pending.id)
        } else {
          runnableRequest = await transaction
            .updateTable('repository_incremental_sync_requests')
            .set({
              status: 'queued',
              claimed_at: null,
              completed_at: null,
              last_error_code: null,
              last_error_message: null,
              updated_at: now,
            })
            .where('id', '=', request.id)
            .where('status', '=', 'running')
            .returningAll()
            .executeTakeFirstOrThrow()
        }
      }

      if (runnableRequest.id === request.id || request.status === 'queued') {
        await enqueueRepositoryIncrementalSyncJob(transaction, runnableRequest, {
          correlationId: `repository.incremental:recovery:${runnableRequest.id}`,
          causationId: `repository-incremental-request:${request.id}:recovered`,
        })
      }

      const recovered = recoveredProjects.get(runnableRequest.project_id)

      if (recovered) {
        for (const requestId of recoveredRequestIds) {
          recovered.requestIds.add(requestId)
        }
      } else {
        recoveredProjects.set(runnableRequest.project_id, {
          projectId: runnableRequest.project_id,
          repositoryId: runnableRequest.repository_id,
          configurationVersion: runnableRequest.configuration_version,
          requestIds: new Set(recoveredRequestIds),
        })
      }
    }

    return [...recoveredProjects.values()].map((project) => ({
      projectId: project.projectId,
      repositoryId: project.repositoryId,
      configurationVersion: project.configurationVersion,
      requestIds: [...project.requestIds].toSorted(),
    }))
  })
}

async function acquireIncrementalSyncIntentLock(
  transaction: Transaction<DatabaseSchema>,
  repositoryId: string,
  syncType: RepositoryIncrementalSyncType,
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(
      hashtextextended(
        ${`shipgate:repository-incremental-sync:${repositoryId}:${syncType}`},
        0
      )
    )
  `.execute(transaction)
}

async function enqueueRepositoryIncrementalSyncJob(
  transaction: Transaction<DatabaseSchema>,
  request: Pick<
    Selectable<DatabaseSchema['repository_incremental_sync_requests']>,
    'id' | 'sync_type'
  >,
  metadata: { readonly correlationId: string; readonly causationId: string },
): Promise<void> {
  const taskName = toTaskName(request.sync_type)

  await enqueueJobInTransaction(
    transaction,
    taskName,
    { requestId: request.id },
    {
      correlationId: metadata.correlationId,
      causationId: metadata.causationId,
      jobKey: `repository.incremental:${request.id}`,
    },
  )
}

function toTaskName(syncType: RepositoryIncrementalSyncType) {
  switch (syncType) {
    case 'refresh_branches':
      return 'repository.refresh-branches' as const
    case 'refresh_change':
      return 'repository.refresh-change' as const
    case 'refresh_checks':
      return 'repository.refresh-checks' as const
    case 'refresh_rules':
      return 'repository.refresh-rules' as const
  }
}

export function normalizeRepositoryIncrementalSyncScope(
  scope: Partial<RepositoryIncrementalSyncScope>,
): RepositoryIncrementalSyncScope {
  return {
    reasons: normalizeStrings(scope.reasons ?? []),
    installationId: normalizeOptionalGitHubId(scope.installationId),
    deliveryIds: normalizeStrings(scope.deliveryIds ?? []),
    branchNames: normalizeStrings(scope.branchNames ?? []),
    pullRequestNumbers: normalizePositiveIntegers(scope.pullRequestNumbers ?? []),
    commitShas: normalizeShas(scope.commitShas ?? []),
    beforeShas: normalizeShas(scope.beforeShas ?? []),
    afterShas: normalizeShas(scope.afterShas ?? []),
    forced: scope.forced === true,
    refreshMetadata: scope.refreshMetadata === true,
    requireReconciliation: scope.requireReconciliation === true,
  }
}

export function mergeRepositoryIncrementalSyncScopes(
  left: RepositoryIncrementalSyncScope,
  right: RepositoryIncrementalSyncScope,
): RepositoryIncrementalSyncScope {
  return normalizeRepositoryIncrementalSyncScope({
    reasons: [...left.reasons, ...right.reasons],
    installationId: right.installationId ?? left.installationId,
    deliveryIds: [...left.deliveryIds, ...right.deliveryIds],
    branchNames: [...left.branchNames, ...right.branchNames],
    pullRequestNumbers: [...left.pullRequestNumbers, ...right.pullRequestNumbers],
    commitShas: [...left.commitShas, ...right.commitShas],
    beforeShas: [...left.beforeShas, ...right.beforeShas],
    afterShas: [...left.afterShas, ...right.afterShas],
    forced: left.forced || right.forced,
    refreshMetadata: left.refreshMetadata || right.refreshMetadata,
    requireReconciliation: left.requireReconciliation || right.requireReconciliation,
  })
}

export function parseRepositoryIncrementalSyncScope(
  value: JsonValue,
): RepositoryIncrementalSyncScope {
  if (!isRecord(value)) {
    throw new Error('Stored repository incremental synchronization scope is invalid')
  }

  const installationId = readNullableString(value.installationId)

  return normalizeRepositoryIncrementalSyncScope({
    reasons: readStringArray(value.reasons),
    ...(installationId !== undefined ? { installationId } : {}),
    deliveryIds: readStringArray(value.deliveryIds),
    branchNames: readStringArray(value.branchNames),
    pullRequestNumbers: readNumberArray(value.pullRequestNumbers),
    commitShas: readStringArray(value.commitShas),
    beforeShas: readStringArray(value.beforeShas),
    afterShas: readStringArray(value.afterShas),
    forced: value.forced === true,
    refreshMetadata: value.refreshMetadata === true,
    requireReconciliation: value.requireReconciliation === true,
  })
}

function mapRequest(
  row: Selectable<DatabaseSchema['repository_incremental_sync_requests']>,
): RepositoryIncrementalSyncRequestRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    configurationVersion: row.configuration_version,
    syncType: row.sync_type,
    status: row.status,
    scope: parseRepositoryIncrementalSyncScope(row.scope),
    requestedAt: row.requested_at,
  }
}

function normalizeOptionalGitHubId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }

  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError('Incremental synchronization installation ID must be a positive decimal ID')
  }

  return value
}

function normalizeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].toSorted()
}

function normalizePositiveIntegers(values: readonly number[]): readonly number[] {
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('Incremental synchronization pull request number must be positive')
    }
  }

  return [...new Set(values)].toSorted((left, right) => left - right)
}

function normalizeShas(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => value.toLowerCase())

  for (const value of normalized) {
    if (!/^[0-9a-f]{40,64}$/.test(value)) {
      throw new TypeError(`Incremental synchronization commit SHA is invalid: ${value}`)
    }
  }

  return [...new Set(normalized)].toSorted()
}

function readNullableString(value: JsonValue | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string') return value
  throw new Error('Stored repository incremental synchronization scalar scope is invalid')
}

function readStringArray(value: JsonValue | undefined): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('Stored repository incremental synchronization string scope is invalid')
  }
  return value
}

function readNumberArray(value: JsonValue | undefined): readonly number[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'number')) {
    throw new Error('Stored repository incremental synchronization number scope is invalid')
  }
  return value
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
