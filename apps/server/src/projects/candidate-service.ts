import { randomUUID } from 'node:crypto'

import type {
  DatabaseClient,
  JsonValue,
  ReleaseCandidateEvaluationResult,
  ReleaseCandidateEvaluationStatus,
} from '@shipgate/database'

import type {
  GitHubRepositoryAccessService,
  RepositoryAccessDecision,
} from '../github-access/index.js'
import {
  ensureActiveDraftCandidateInTransaction,
  parseCandidateEvaluationReasons,
  touchProjectReleaseStateAndQueueEvaluation,
} from './candidate-evaluation-queue.js'
import {
  ChangeNotFoundError,
  ProjectConfigurationValidationError,
  ProjectNotFoundError,
} from './errors.js'
import { withRepositoryTransaction } from './repository-transaction.js'
import { getProject } from './store.js'

export interface ActiveDraftCandidateEvaluation {
  readonly id: string
  readonly version: number
  readonly result: ReleaseCandidateEvaluationResult
  readonly summary: JsonValue
  readonly blockers: JsonValue
  readonly evaluatedAt: Date
  readonly projectStateVersion: number
  readonly projectionVersion: number
}

export interface ActiveDraftCandidatePendingEvaluation {
  readonly requestId: string
  readonly status: 'queued' | 'running'
  readonly reasons: readonly string[]
  readonly coalescedCount: number
  readonly requestedAt: Date
  readonly claimedAt: Date | null
}

export interface ActiveDraftCandidateExclusion {
  readonly changeId: string
  readonly pullRequestNumber: number | null
  readonly title: string | null
  readonly actorGitHubUserId: string
  readonly reason: string | null
  readonly candidateVersion: number
  readonly excludedAt: Date
  readonly updatedAt: Date
}

export interface ActiveDraftCandidate {
  readonly id: string
  readonly sequence: number
  readonly version: number
  readonly status: ReleaseCandidateEvaluationStatus
  readonly createdByGitHubUserId: string | null
  readonly latestEvaluationVersion: number | null
  readonly latestEvaluation: ActiveDraftCandidateEvaluation | null
  readonly pendingEvaluation: ActiveDraftCandidatePendingEvaluation | null
  readonly exclusions: readonly ActiveDraftCandidateExclusion[]
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface ExcludeChange {
  readonly actorGitHubUserId: number
  readonly projectId: string
  readonly changeId: string
  readonly reason?: string
  readonly correlationId: string
}

export interface RestoreChange {
  readonly actorGitHubUserId: number
  readonly projectId: string
  readonly changeId: string
  readonly correlationId: string
}

export type CandidateExclusionMutationResult =
  | {
      readonly status: 'recorded'
      readonly candidateId: string
      readonly candidateVersion: number
      readonly changeId: string
      readonly excluded: boolean
      readonly evaluationRequestId: string | null
    }
  | {
      readonly status: 'already_applied'
      readonly candidateId: string
      readonly candidateVersion: number
      readonly changeId: string
      readonly excluded: boolean
      readonly evaluationRequestId: null
    }

export interface CandidateService {
  get(input: {
    readonly actorGitHubUserId: number
    readonly projectId: string
  }): Promise<ActiveDraftCandidate | null>

  exclude(input: ExcludeChange): Promise<CandidateExclusionMutationResult>

  restore(input: RestoreChange): Promise<CandidateExclusionMutationResult>
}

export function createCandidateService(options: {
  readonly database: DatabaseClient
  readonly githubRepositoryAccess: GitHubRepositoryAccessService
}): CandidateService {
  return {
    async get(input) {
      const project = await requireProjectAccess(
        options,
        input.actorGitHubUserId,
        input.projectId,
        'read',
      )
      return loadActiveCandidate(options.database, project.id)
    },

    async exclude(input) {
      const project = await requireProjectAccess(
        options,
        input.actorGitHubUserId,
        input.projectId,
        'triage',
      )
      const repositoryId = parseGitHubId(project.repositoryId, 'repository ID')
      const reason = normalizeExclusionReason(input.reason)

      return withRepositoryTransaction(options.database, repositoryId, async (scope) => {
        const projectRow = await scope.transaction
          .selectFrom('projects')
          .select(projectCoordinateColumns)
          .where('id', '=', input.projectId)
          .where('repository_id', '=', project.repositoryId)
          .forUpdate()
          .executeTakeFirst()

        if (projectRow?.status !== 'active') {
          throw new ProjectConfigurationValidationError(
            'project_not_active',
            `Project ${input.projectId} is not active and cannot change candidate exclusions`,
          )
        }

        const candidate = await ensureActiveDraftCandidateInTransaction(scope.transaction, {
          project: projectRow,
        })

        if (!candidate) {
          throw new ProjectConfigurationValidationError(
            'project_not_active',
            `Project ${input.projectId} has no successful projection for a draft candidate`,
          )
        }

        const change = await scope.transaction
          .selectFrom('changes')
          .select(['id', 'synchronization_state', 'production_presence'])
          .where('id', '=', input.changeId)
          .where('project_id', '=', input.projectId)
          .where('repository_id', '=', project.repositoryId)
          .forUpdate()
          .executeTakeFirst()

        if (!change) {
          throw new ChangeNotFoundError(input.projectId, input.changeId)
        }

        if (change.synchronization_state !== 'known' || change.production_presence === 'released') {
          throw new ProjectConfigurationValidationError(
            'change_not_releasable',
            `Change ${change.id} is not an includable current draft-candidate change`,
            {
              details: {
                synchronizationState: change.synchronization_state,
                productionPresence: change.production_presence,
              },
            },
          )
        }

        const existing = await scope.transaction
          .selectFrom('candidate_exclusions')
          .select(['reason', 'candidate_version'])
          .where('candidate_id', '=', candidate.id)
          .where('change_id', '=', change.id)
          .forUpdate()
          .executeTakeFirst()

        if (existing?.reason === reason) {
          return {
            status: 'already_applied',
            candidateId: candidate.id,
            candidateVersion: candidate.version,
            changeId: change.id,
            excluded: true,
            evaluationRequestId: null,
          }
        }

        const now = new Date()
        const nextCandidateVersion = candidate.version + 1

        await scope.transaction
          .updateTable('release_candidates')
          .set({
            version: nextCandidateVersion,
            latest_evaluation_version: null,
            evaluation_status: 'evaluating',
            updated_at: now,
          })
          .where('id', '=', candidate.id)
          .where('version', '=', candidate.version)
          .executeTakeFirstOrThrow()

        await scope.transaction
          .insertInto('candidate_exclusions')
          .values({
            candidate_id: candidate.id,
            project_id: projectRow.id,
            repository_id: projectRow.repository_id,
            change_id: change.id,
            actor_github_user_id: String(input.actorGitHubUserId),
            reason,
            candidate_version: nextCandidateVersion,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(['candidate_id', 'change_id']).doUpdateSet({
              actor_github_user_id: String(input.actorGitHubUserId),
              reason,
              candidate_version: nextCandidateVersion,
              updated_at: now,
            }),
          )
          .execute()

        const reevaluation = await touchProjectReleaseStateAndQueueEvaluation(scope, {
          projectId: projectRow.id,
          repositoryId: projectRow.repository_id,
          reason: 'exclusion_changed',
          clearLatestEvaluation: true,
          now,
        })

        await scope.transaction
          .insertInto('audit_events')
          .values({
            id: randomUUID(),
            project_id: projectRow.id,
            repository_id: projectRow.repository_id,
            actor_github_user_id: String(input.actorGitHubUserId),
            event_type: 'change_excluded',
            source: 'user',
            configuration_version: projectRow.configuration_version,
            entity_type: 'candidate_exclusion',
            entity_id: `${candidate.id}:${change.id}`,
            correlation_id: input.correlationId,
            reason_code: 'change_excluded',
            before_state: existing
              ? JSON.stringify({ excluded: true, reason: existing.reason })
              : JSON.stringify({ excluded: false }),
            after_state: JSON.stringify({ excluded: true, reason }),
            payload: JSON.stringify({
              candidateId: candidate.id,
              candidateVersion: nextCandidateVersion,
              changeId: change.id,
              evaluationRequestId: reevaluation?.requestId ?? null,
            } satisfies JsonValue),
            occurred_at: now,
          })
          .execute()

        return {
          status: 'recorded',
          candidateId: candidate.id,
          candidateVersion: nextCandidateVersion,
          changeId: change.id,
          excluded: true,
          evaluationRequestId: reevaluation?.requestId ?? null,
        }
      })
    },

    async restore(input) {
      const project = await requireProjectAccess(
        options,
        input.actorGitHubUserId,
        input.projectId,
        'triage',
      )
      const repositoryId = parseGitHubId(project.repositoryId, 'repository ID')

      return withRepositoryTransaction(options.database, repositoryId, async (scope) => {
        const projectRow = await scope.transaction
          .selectFrom('projects')
          .select(projectCoordinateColumns)
          .where('id', '=', input.projectId)
          .where('repository_id', '=', project.repositoryId)
          .forUpdate()
          .executeTakeFirst()

        if (projectRow?.status !== 'active') {
          throw new ProjectConfigurationValidationError(
            'project_not_active',
            `Project ${input.projectId} is not active and cannot change candidate exclusions`,
          )
        }

        const candidate = await ensureActiveDraftCandidateInTransaction(scope.transaction, {
          project: projectRow,
        })

        if (!candidate) {
          throw new ProjectConfigurationValidationError(
            'project_not_active',
            `Project ${input.projectId} has no successful projection for a draft candidate`,
          )
        }

        const existing = await scope.transaction
          .selectFrom('candidate_exclusions')
          .selectAll()
          .where('candidate_id', '=', candidate.id)
          .where('change_id', '=', input.changeId)
          .forUpdate()
          .executeTakeFirst()

        if (!existing) {
          return {
            status: 'already_applied',
            candidateId: candidate.id,
            candidateVersion: candidate.version,
            changeId: input.changeId,
            excluded: false,
            evaluationRequestId: null,
          }
        }

        const now = new Date()
        const nextCandidateVersion = candidate.version + 1

        await scope.transaction
          .updateTable('release_candidates')
          .set({
            version: nextCandidateVersion,
            latest_evaluation_version: null,
            evaluation_status: 'evaluating',
            updated_at: now,
          })
          .where('id', '=', candidate.id)
          .where('version', '=', candidate.version)
          .executeTakeFirstOrThrow()
        await scope.transaction
          .deleteFrom('candidate_exclusions')
          .where('candidate_id', '=', candidate.id)
          .where('change_id', '=', input.changeId)
          .returning('change_id')
          .executeTakeFirstOrThrow()

        const reevaluation = await touchProjectReleaseStateAndQueueEvaluation(scope, {
          projectId: projectRow.id,
          repositoryId: projectRow.repository_id,
          reason: 'exclusion_changed',
          clearLatestEvaluation: true,
          now,
        })

        await scope.transaction
          .insertInto('audit_events')
          .values({
            id: randomUUID(),
            project_id: projectRow.id,
            repository_id: projectRow.repository_id,
            actor_github_user_id: String(input.actorGitHubUserId),
            event_type: 'change_restored',
            source: 'user',
            configuration_version: projectRow.configuration_version,
            entity_type: 'candidate_exclusion',
            entity_id: `${candidate.id}:${input.changeId}`,
            correlation_id: input.correlationId,
            reason_code: 'change_restored',
            before_state: JSON.stringify({ excluded: true, reason: existing.reason }),
            after_state: JSON.stringify({ excluded: false }),
            payload: JSON.stringify({
              candidateId: candidate.id,
              candidateVersion: nextCandidateVersion,
              changeId: input.changeId,
              evaluationRequestId: reevaluation?.requestId ?? null,
            } satisfies JsonValue),
            occurred_at: now,
          })
          .execute()

        return {
          status: 'recorded',
          candidateId: candidate.id,
          candidateVersion: nextCandidateVersion,
          changeId: input.changeId,
          excluded: false,
          evaluationRequestId: reevaluation?.requestId ?? null,
        }
      })
    },
  }
}

async function loadActiveCandidate(
  database: DatabaseClient,
  projectId: string,
): Promise<ActiveDraftCandidate | null> {
  return database.kysely
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (transaction) => {
      const candidate = await transaction
        .selectFrom('release_candidates')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('state', '=', 'open')
        .executeTakeFirst()

      if (!candidate) {
        return null
      }

      const [latestEvaluation, pendingEvaluation, exclusionRows] = await Promise.all([
        candidate.latest_evaluation_version === null
          ? Promise.resolve(null)
          : transaction
              .selectFrom('release_candidate_evaluations')
              .selectAll()
              .where('candidate_id', '=', candidate.id)
              .where('evaluation_version', '=', candidate.latest_evaluation_version)
              .executeTakeFirst(),
        transaction
          .selectFrom('release_candidate_evaluation_requests')
          .selectAll()
          .where('candidate_id', '=', candidate.id)
          .where('status', 'in', ['queued', 'running'])
          .orderBy('requested_at', 'desc')
          .executeTakeFirst(),
        transaction
          .selectFrom('candidate_exclusions as exclusion')
          .leftJoin('changes as change', (join) =>
            join
              .onRef('change.project_id', '=', 'exclusion.project_id')
              .onRef('change.repository_id', '=', 'exclusion.repository_id')
              .onRef('change.id', '=', 'exclusion.change_id'),
          )
          .select([
            'exclusion.change_id',
            'exclusion.actor_github_user_id',
            'exclusion.reason',
            'exclusion.candidate_version',
            'exclusion.created_at',
            'exclusion.updated_at',
            'change.pull_request_number',
            'change.title',
          ])
          .where('exclusion.candidate_id', '=', candidate.id)
          .orderBy('change.pull_request_number')
          .orderBy('exclusion.change_id')
          .execute(),
      ])

      return {
        id: candidate.id,
        sequence: candidate.sequence,
        version: candidate.version,
        status: candidate.evaluation_status,
        createdByGitHubUserId: candidate.created_by_github_user_id,
        latestEvaluationVersion: candidate.latest_evaluation_version,
        latestEvaluation: latestEvaluation
          ? {
              id: latestEvaluation.id,
              version: latestEvaluation.evaluation_version,
              result: latestEvaluation.result,
              summary: latestEvaluation.summary,
              blockers: latestEvaluation.blockers,
              evaluatedAt: latestEvaluation.evaluated_at,
              projectStateVersion: latestEvaluation.project_state_version,
              projectionVersion: latestEvaluation.projection_version,
            }
          : null,
        pendingEvaluation:
          pendingEvaluation?.status === 'queued' || pendingEvaluation?.status === 'running'
            ? {
                requestId: pendingEvaluation.id,
                status: pendingEvaluation.status,
                reasons: parseCandidateEvaluationReasons(pendingEvaluation.reasons),
                coalescedCount: pendingEvaluation.coalesced_count,
                requestedAt: pendingEvaluation.requested_at,
                claimedAt: pendingEvaluation.claimed_at,
              }
            : null,
        exclusions: exclusionRows.map((exclusion) => ({
          changeId: exclusion.change_id,
          pullRequestNumber: exclusion.pull_request_number,
          title: exclusion.title,
          actorGitHubUserId: exclusion.actor_github_user_id,
          reason: exclusion.reason,
          candidateVersion: exclusion.candidate_version,
          excludedAt: exclusion.created_at,
          updatedAt: exclusion.updated_at,
        })),
        createdAt: candidate.created_at,
        updatedAt: candidate.updated_at,
      }
    })
}

async function requireProjectAccess(
  options: {
    readonly database: DatabaseClient
    readonly githubRepositoryAccess: GitHubRepositoryAccessService
  },
  githubUserId: number,
  projectId: string,
  permission: 'read' | 'triage',
) {
  const project = await getProject(options.database, projectId)

  if (!project || project.status === 'deleted') {
    throw new ProjectNotFoundError(projectId)
  }

  if (permission === 'triage') {
    options.githubRepositoryAccess.invalidateUser(githubUserId)
  }

  let decision: RepositoryAccessDecision

  try {
    decision = await options.githubRepositoryAccess.authorizeRepositoryAccess({
      githubUserId,
      installationId: parseGitHubId(project.installationId, 'installation ID'),
      repositoryId: parseGitHubId(project.repositoryId, 'repository ID'),
      requiredPermission: {
        repository: permission,
        app: { name: 'metadata', level: 'read' },
      },
    })
  } catch (cause) {
    throw new ProjectConfigurationValidationError(
      'external_state_unknown',
      'Current GitHub repository access could not be verified',
      { cause },
    )
  }

  if (!decision.allowed) {
    if (permission === 'read') {
      throw new ProjectNotFoundError(projectId)
    }

    throw new ProjectConfigurationValidationError(
      decision.reason === 'insufficient_repository_permission'
        ? 'permission_missing'
        : 'external_state_unknown',
      decision.reason === 'insufficient_repository_permission'
        ? 'GitHub Triage or higher repository permission is required'
        : 'Current GitHub repository access could not be verified',
      { details: { reason: decision.reason } },
    )
  }

  return project
}

function normalizeExclusionReason(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''

  if (normalized.length === 0) return null

  if (normalized.length > 4_000 || normalized.includes('\u0000')) {
    throw new ProjectConfigurationValidationError(
      'invalid_exclusion_reason',
      'Candidate exclusion reason must contain at most 4000 characters and no NUL bytes',
    )
  }

  return normalized
}

function parseGitHubId(value: string, name: string): number {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Stored ${name} is outside JavaScript's safe integer range: ${value}`)
  }

  return parsed
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
