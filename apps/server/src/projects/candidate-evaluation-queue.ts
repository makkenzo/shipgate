import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseSchema, JsonValue } from '@shipgate/database'
import { enqueueJobInTransaction } from '@shipgate/jobs'
import { type Selectable, sql, type Transaction } from 'kysely'

import {
  assertRepositoryTransaction,
  type RepositoryTransaction,
  withRepositoryTransaction,
} from './repository-transaction.js'

export type CandidateEvaluationReason =
  | 'first_projection'
  | 'qa_changed'
  | 'dependencies_changed'
  | 'exclusion_changed'
  | 'required_checks_changed'
  | 'check_result_changed'
  | 'source_topology_changed'
  | 'production_changed'
  | 'project_degraded'
  | 'reconciliation_corrected'
  | 'worker_recovery'
  | 'state_changed_during_evaluation'

export interface CandidateReevaluationReference {
  readonly candidateId: string
  readonly candidateVersion: number
  readonly requestId: string | null
}

export interface ProjectReleaseStateCoordinates {
  readonly id: string
  readonly repository_id: string
  readonly status: Selectable<DatabaseSchema['projects']>['status']
  readonly source_sha: string | null
  readonly production_sha: string | null
  readonly last_successful_sync_at: Date | null
  readonly configuration_version: number
  readonly required_check_policy_version: number
  readonly release_state_version: number
  readonly projection_version: number
}

export async function touchProjectReleaseStateAndQueueEvaluation(
  scope: RepositoryTransaction,
  input: {
    readonly projectId: string
    readonly repositoryId: string
    readonly reason: CandidateEvaluationReason
    readonly projectionChanged?: boolean
    readonly clearLatestEvaluation?: boolean
    readonly deferEvaluation?: boolean
    readonly now?: Date
  },
): Promise<CandidateReevaluationReference | null> {
  const repositoryId = assertRepositoryTransaction(scope, input.repositoryId)
  const now = input.now ?? new Date()
  const project = await scope.transaction
    .updateTable('projects')
    .set({
      release_state_version: sql<number>`release_state_version + 1`,
      ...(input.projectionChanged
        ? { projection_version: sql<number>`projection_version + 1` }
        : {}),
      updated_at: now,
    })
    .where('id', '=', input.projectId)
    .where('repository_id', '=', repositoryId)
    .where('status', 'not in', ['pending_deletion', 'deleted'])
    .returning(projectCoordinateColumns)
    .executeTakeFirst()

  if (!project) {
    return null
  }

  return queueActiveCandidateEvaluationInTransaction(scope.transaction, {
    project,
    reason: input.reason,
    clearLatestEvaluation: input.clearLatestEvaluation ?? false,
    deferEvaluation: input.deferEvaluation ?? false,
    now,
  })
}

export async function queueActiveCandidateEvaluationInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly project: ProjectReleaseStateCoordinates
    readonly reason: CandidateEvaluationReason
    readonly clearLatestEvaluation?: boolean
    readonly deferEvaluation?: boolean
    readonly now?: Date
  },
): Promise<CandidateReevaluationReference | null> {
  const now = input.now ?? new Date()
  const candidate = await ensureActiveDraftCandidateInTransaction(transaction, {
    project: input.project,
    now,
  })

  if (!candidate) {
    return null
  }

  await transaction
    .updateTable('release_candidates')
    .set({
      evaluation_status: 'evaluating',
      ...(input.clearLatestEvaluation ? { latest_evaluation_version: null } : {}),
      updated_at: now,
    })
    .where('id', '=', candidate.id)
    .where('version', '=', candidate.version)
    .executeTakeFirstOrThrow()

  if (input.deferEvaluation) {
    return {
      candidateId: candidate.id,
      candidateVersion: candidate.version,
      requestId: null,
    }
  }

  if (
    input.project.source_sha === null ||
    input.project.production_sha === null ||
    input.project.last_successful_sync_at === null
  ) {
    return {
      candidateId: candidate.id,
      candidateVersion: candidate.version,
      requestId: null,
    }
  }

  const reason = normalizeReason(input.reason)
  const existing = await transaction
    .selectFrom('release_candidate_evaluation_requests')
    .selectAll()
    .where('project_id', '=', input.project.id)
    .where('status', '=', 'queued')
    .forUpdate()
    .executeTakeFirst()

  if (existing) {
    const reasons = normalizeReasons([...parseReasons(existing.reasons), reason])

    await transaction
      .updateTable('release_candidate_evaluation_requests')
      .set({
        candidate_id: candidate.id,
        project_state_version: input.project.release_state_version,
        projection_version: input.project.projection_version,
        candidate_version: candidate.version,
        configuration_version: input.project.configuration_version,
        required_check_policy_version: input.project.required_check_policy_version,
        source_sha: input.project.source_sha,
        production_sha: input.project.production_sha,
        reasons: JSON.stringify(reasons),
        coalesced_count: sql<number>`coalesced_count + 1`,
        last_error_code: null,
        last_error_message: null,
        updated_at: now,
      })
      .where('id', '=', existing.id)
      .where('status', '=', 'queued')
      .executeTakeFirstOrThrow()

    return {
      candidateId: candidate.id,
      candidateVersion: candidate.version,
      requestId: existing.id,
    }
  }

  const requestId = randomUUID()

  await transaction
    .insertInto('release_candidate_evaluation_requests')
    .values({
      id: requestId,
      project_id: input.project.id,
      repository_id: input.project.repository_id,
      candidate_id: candidate.id,
      status: 'queued',
      project_state_version: input.project.release_state_version,
      projection_version: input.project.projection_version,
      candidate_version: candidate.version,
      configuration_version: input.project.configuration_version,
      required_check_policy_version: input.project.required_check_policy_version,
      source_sha: input.project.source_sha,
      production_sha: input.project.production_sha,
      reasons: JSON.stringify([reason]),
      coalesced_count: 0,
      attempt_count: 0,
      last_error_code: null,
      last_error_message: null,
      requested_at: now,
      claimed_at: null,
      completed_at: null,
      updated_at: now,
    })
    .execute()

  await enqueueCandidateEvaluationJob(transaction, requestId, input.project.id)

  return {
    candidateId: candidate.id,
    candidateVersion: candidate.version,
    requestId,
  }
}

export async function ensureActiveDraftCandidateInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly project: ProjectReleaseStateCoordinates
    readonly now?: Date
  },
): Promise<Selectable<DatabaseSchema['release_candidates']> | null> {
  const now = input.now ?? new Date()
  const existing = await transaction
    .selectFrom('release_candidates')
    .selectAll()
    .where('project_id', '=', input.project.id)
    .where('repository_id', '=', input.project.repository_id)
    .where('state', '=', 'open')
    .forUpdate()
    .executeTakeFirst()

  if (existing) {
    return existing
  }

  if (
    input.project.source_sha === null ||
    input.project.production_sha === null ||
    input.project.last_successful_sync_at === null ||
    input.project.status === 'pending_deletion' ||
    input.project.status === 'deleted'
  ) {
    return null
  }

  const latest = await transaction
    .selectFrom('release_candidates')
    .select(({ fn }) => fn.max<number>('sequence').as('sequence'))
    .where('project_id', '=', input.project.id)
    .executeTakeFirst()
  const candidateId = randomUUID()
  const sequence = (latest?.sequence ?? 0) + 1
  const candidate = await transaction
    .insertInto('release_candidates')
    .values({
      id: candidateId,
      project_id: input.project.id,
      repository_id: input.project.repository_id,
      sequence,
      state: 'open',
      version: 1,
      created_by_github_user_id: null,
      note: null,
      latest_evaluation_version: null,
      evaluation_status: 'evaluating',
      closed_at: null,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  await transaction
    .insertInto('audit_events')
    .values({
      id: randomUUID(),
      project_id: input.project.id,
      repository_id: input.project.repository_id,
      actor_github_user_id: null,
      event_type: 'release_candidate_created',
      source: 'system',
      configuration_version: input.project.configuration_version,
      entity_type: 'release_candidate',
      entity_id: candidateId,
      correlation_id: null,
      reason_code: 'first_successful_projection',
      before_state: null,
      after_state: JSON.stringify({
        candidateId,
        sequence,
        version: 1,
        status: 'evaluating',
      }),
      payload: JSON.stringify({
        automatic: true,
        projectStateVersion: input.project.release_state_version,
        projectionVersion: input.project.projection_version,
      } satisfies JsonValue),
      occurred_at: now,
    })
    .execute()

  return candidate
}

export async function recoverActiveDraftCandidateEvaluations(
  database: DatabaseClient,
): Promise<{ readonly projects: number; readonly jobs: number }> {
  const projects = await database.kysely
    .selectFrom('projects')
    .select(['id', 'repository_id'])
    .where('last_successful_sync_at', 'is not', null)
    .where('status', 'not in', ['pending_deletion', 'deleted'])
    .orderBy('repository_id')
    .execute()
  let recoveredProjects = 0
  let recoveredJobs = 0

  for (const target of projects) {
    const recovered = await withRepositoryTransaction(
      database,
      target.repository_id,
      async ({ transaction }) => {
        let project = await transaction
          .selectFrom('projects')
          .select(projectCoordinateColumns)
          .where('id', '=', target.id)
          .where('repository_id', '=', target.repository_id)
          .forUpdate()
          .executeTakeFirst()

        if (!project || project.status === 'pending_deletion' || project.status === 'deleted') {
          return { project: false, jobs: 0 }
        }

        if (project.release_state_version === 0 || project.projection_version === 0) {
          project = await transaction
            .updateTable('projects')
            .set({
              release_state_version: Math.max(1, project.release_state_version),
              projection_version: Math.max(1, project.projection_version),
            })
            .where('id', '=', project.id)
            .returning(projectCoordinateColumns)
            .executeTakeFirstOrThrow()
        }

        const candidate = await ensureActiveDraftCandidateInTransaction(transaction, {
          project,
        })

        if (!candidate) {
          return { project: false, jobs: 0 }
        }

        let jobs = 0
        const activeRequests = await transaction
          .selectFrom('release_candidate_evaluation_requests')
          .select(['id', 'status'])
          .where('project_id', '=', project.id)
          .where('status', 'in', ['queued', 'running'])
          .orderBy('requested_at')
          .forUpdate()
          .execute()

        const queuedRequest = activeRequests.find((request) => request.status === 'queued')

        for (const request of activeRequests) {
          const job = await sql<{ readonly exists: boolean }>`
            select exists (
              select 1
              from graphile_worker.jobs
              where key = ${`release.evaluate-candidate:${request.id}`}
            ) as exists
          `.execute(transaction)

          if (job.rows[0]?.exists) {
            continue
          }

          if (request.status === 'running' && queuedRequest) {
            await transaction
              .updateTable('release_candidate_evaluation_requests')
              .set({
                status: 'superseded',
                completed_at: new Date(),
                last_error_code: 'worker_recovery_coalesced',
                last_error_message:
                  'Orphaned running evaluation was superseded by a queued request',
                updated_at: new Date(),
              })
              .where('id', '=', request.id)
              .where('status', '=', 'running')
              .executeTakeFirstOrThrow()
            continue
          }

          if (request.status === 'running') {
            await transaction
              .updateTable('release_candidate_evaluation_requests')
              .set({
                status: 'queued',
                claimed_at: null,
                completed_at: null,
                last_error_code: 'worker_recovery',
                last_error_message: 'Evaluation worker stopped before completing the request',
                updated_at: new Date(),
              })
              .where('id', '=', request.id)
              .where('status', '=', 'running')
              .executeTakeFirstOrThrow()
          }

          await enqueueCandidateEvaluationJob(transaction, request.id, project.id)
          jobs += 1
        }

        if (activeRequests.length === 0 && candidate.evaluation_status === 'evaluating') {
          const queued = await queueActiveCandidateEvaluationInTransaction(transaction, {
            project,
            reason: 'worker_recovery',
          })
          jobs += queued?.requestId ? 1 : 0
        }

        return { project: true, jobs }
      },
    )

    recoveredProjects += recovered.project ? 1 : 0
    recoveredJobs += recovered.jobs
  }

  return { projects: recoveredProjects, jobs: recoveredJobs }
}

export function parseCandidateEvaluationReasons(value: JsonValue): readonly string[] {
  return parseReasons(value)
}

const projectCoordinateColumns = [
  'id',
  'repository_id',
  'status',
  'source_sha',
  'production_sha',
  'last_successful_sync_at',
  'configuration_version',
  'required_check_policy_version',
  'release_state_version',
  'projection_version',
] as const

async function enqueueCandidateEvaluationJob(
  transaction: Transaction<DatabaseSchema>,
  requestId: string,
  projectId: string,
): Promise<void> {
  await enqueueJobInTransaction(
    transaction,
    'release.evaluate-candidate',
    { requestId },
    {
      correlationId: `release.evaluate-candidate:${projectId}:${requestId}`,
      causationId: `release-candidate-evaluation-request:${requestId}`,
      jobKey: `release.evaluate-candidate:${requestId}`,
    },
  )
}

function normalizeReason(value: string): string {
  const normalized = value.trim()

  if (!/^[a-z][a-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new TypeError(`Candidate evaluation reason is invalid: ${value}`)
  }

  return normalized
}

function normalizeReasons(values: readonly string[]): readonly string[] {
  return [...new Set(values.map(normalizeReason))].toSorted()
}

function parseReasons(value: JsonValue): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('Stored candidate evaluation reasons are invalid')
  }

  return normalizeReasons(value)
}
