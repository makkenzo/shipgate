import { randomUUID } from 'node:crypto'

import type { JsonValue, QaAssessmentStatus } from '@shipgate/database'

import { touchProjectReleaseStateAndQueueEvaluation } from './candidate-evaluation-queue.js'
import {
  ChangeNotFoundError,
  ProjectConfigurationValidationError,
  ProjectNotFoundError,
} from './errors.js'
import type { ChangeQaState } from './model.js'
import {
  assertRepositoryTransaction,
  type RepositoryTransaction,
} from './repository-transaction.js'

export type SetQaStatus = {
  readonly actorGitHubUserId: number
  readonly projectId: string
  readonly changeId: string
  readonly status: Exclude<QaAssessmentStatus, 'pending'>
  readonly comment?: string
  readonly correlationId: string
}

export type ResetQaStatus = {
  readonly actorGitHubUserId: number
  readonly projectId: string
  readonly changeId: string
  readonly comment?: string
  readonly correlationId: string
}

export interface CandidateReevaluation {
  readonly candidateId: string
  readonly candidateVersion: number
}

export interface ChangeQaMutationResult {
  readonly status: 'recorded' | 'already_applied'
  readonly qa: ChangeQaState
  readonly candidateReevaluation: CandidateReevaluation | null
}

type QaMutationInput = {
  readonly actorGitHubUserId: number
  readonly projectId: string
  readonly changeId: string
  readonly status: QaAssessmentStatus
  readonly comment?: string
  readonly correlationId: string
  readonly reason: 'set' | 'reset'
  readonly now?: Date
}

export async function setQaStatus(
  scope: RepositoryTransaction,
  command: SetQaStatus,
): Promise<ChangeQaMutationResult> {
  return recordQaAssessment(scope, {
    ...command,
    reason: 'set',
  })
}

export async function resetQaStatus(
  scope: RepositoryTransaction,
  command: ResetQaStatus,
): Promise<ChangeQaMutationResult> {
  return recordQaAssessment(scope, {
    ...command,
    status: 'pending',
    reason: 'reset',
  })
}

async function recordQaAssessment(
  scope: RepositoryTransaction,
  input: QaMutationInput,
): Promise<ChangeQaMutationResult> {
  const repositoryId = assertRepositoryTransaction(scope, scope.repositoryId)
  const actorGitHubUserId = serializeGitHubUserId(input.actorGitHubUserId)
  const comment = normalizeComment(input.comment)
  const now = input.now ?? new Date()

  assertLocalId(input.projectId, 'project ID')
  assertLocalId(input.changeId, 'change ID')
  assertCorrelationId(input.correlationId)
  assertValidDate(now)

  const project = await scope.transaction
    .selectFrom('projects')
    .select(['id', 'repository_id', 'configuration_version', 'status', 'qa_reset_epoch'])
    .where('id', '=', input.projectId)
    .forUpdate()
    .executeTakeFirst()

  if (!project || project.status === 'deleted') {
    throw new ProjectNotFoundError(input.projectId)
  }

  if (project.repository_id !== repositoryId) {
    throw new ProjectNotFoundError(input.projectId)
  }

  if (project.status !== 'active') {
    throw new ProjectConfigurationValidationError(
      'project_not_active',
      `Project ${project.id} is ${project.status} and cannot accept QA decisions`,
    )
  }

  const change = await scope.transaction
    .selectFrom('changes')
    .select([
      'id',
      'project_id',
      'repository_id',
      'final_head_sha',
      'commit_set_fingerprint',
      'synchronization_state',
      'production_presence',
    ])
    .where('id', '=', input.changeId)
    .where('project_id', '=', project.id)
    .where('repository_id', '=', repositoryId)
    .forUpdate()
    .executeTakeFirst()

  if (!change) {
    throw new ChangeNotFoundError(project.id, input.changeId)
  }

  if (change.synchronization_state !== 'known' || change.commit_set_fingerprint === null) {
    throw new ProjectConfigurationValidationError(
      'change_identity_unknown',
      `Change ${change.id} does not have a stable identity in the current projection`,
      { details: { changeId: change.id } },
    )
  }

  if (
    change.production_presence !== 'unreleased' &&
    change.production_presence !== 'partially_present'
  ) {
    throw new ProjectConfigurationValidationError(
      'change_not_releasable',
      `Change ${change.id} is not part of the current release queue`,
      {
        details: {
          changeId: change.id,
          productionPresence: change.production_presence,
        },
      },
    )
  }

  const current = await scope.transaction
    .selectFrom('effective_change_qa_assessments')
    .select(['id', 'status', 'comment', 'actor_github_user_id', 'created_at', 'sequence'])
    .where('project_id', '=', project.id)
    .where('repository_id', '=', repositoryId)
    .where('change_id', '=', change.id)
    .executeTakeFirst()

  if (current && current.status === input.status && current.comment === comment) {
    return {
      status: 'already_applied',
      qa: mapQaState(current),
      candidateReevaluation: null,
    }
  }

  const latest = await scope.transaction
    .selectFrom('change_qa_assessments')
    .select('sequence')
    .where('project_id', '=', project.id)
    .where('change_id', '=', change.id)
    .orderBy('sequence', 'desc')
    .executeTakeFirst()
  const assessmentId = randomUUID()
  const sequence = (latest?.sequence ?? 0) + 1
  const previousQa = current ? mapQaState(current) : emptyPendingQaState()
  const reasonCode = input.reason === 'reset' ? 'qa_status_reset' : 'qa_status_set'

  await scope.transaction
    .insertInto('change_qa_assessments')
    .values({
      id: assessmentId,
      project_id: project.id,
      repository_id: repositoryId,
      change_id: change.id,
      final_head_sha: change.final_head_sha,
      commit_set_fingerprint: change.commit_set_fingerprint,
      sequence,
      status: input.status,
      actor_github_user_id: actorGitHubUserId,
      comment,
      previous_status: previousQa.status,
      correlation_id: input.correlationId,
      reason_code: reasonCode,
      qa_reset_epoch: project.qa_reset_epoch,
      created_at: now,
    })
    .execute()

  const candidateReevaluation = await touchProjectReleaseStateAndQueueEvaluation(scope, {
    projectId: project.id,
    repositoryId,
    reason: 'qa_changed',
    now,
  })
  const qa: ChangeQaState = {
    status: input.status,
    assessmentId,
    comment,
    actorGitHubUserId,
    assessedAt: now,
  }

  await scope.transaction
    .insertInto('audit_events')
    .values({
      id: randomUUID(),
      project_id: project.id,
      repository_id: repositoryId,
      actor_github_user_id: actorGitHubUserId,
      event_type: 'qa_status_changed',
      source: 'user',
      configuration_version: project.configuration_version,
      entity_type: 'qa_assessment',
      entity_id: assessmentId,
      correlation_id: input.correlationId,
      reason_code: reasonCode,
      before_state: JSON.stringify(toQaJson(previousQa)),
      after_state: JSON.stringify(toQaJson(qa)),
      payload: JSON.stringify({
        changeId: change.id,
        finalHeadSha: change.final_head_sha,
        commitSetFingerprint: change.commit_set_fingerprint,
        qaResetEpoch: project.qa_reset_epoch,
        candidateReevaluation:
          candidateReevaluation === null
            ? null
            : {
                candidateId: candidateReevaluation.candidateId,
                candidateVersion: candidateReevaluation.candidateVersion,
              },
      } satisfies JsonValue),
      occurred_at: now,
    })
    .execute()

  return {
    status: 'recorded',
    qa,
    candidateReevaluation,
  }
}

function mapQaState(input: {
  readonly id: string
  readonly status: QaAssessmentStatus
  readonly comment: string | null
  readonly actor_github_user_id: string | null
  readonly created_at: Date
}): ChangeQaState {
  return {
    status: input.status,
    assessmentId: input.id,
    comment: input.comment,
    actorGitHubUserId: input.actor_github_user_id,
    assessedAt: input.created_at,
  }
}

function emptyPendingQaState(): ChangeQaState {
  return {
    status: 'pending',
    assessmentId: null,
    comment: null,
    actorGitHubUserId: null,
    assessedAt: null,
  }
}

function toQaJson(qa: ChangeQaState): JsonValue {
  return {
    status: qa.status,
    assessmentId: qa.assessmentId,
    comment: qa.comment,
    actorGitHubUserId: qa.actorGitHubUserId,
    assessedAt: qa.assessedAt?.toISOString() ?? null,
  }
}

function serializeGitHubUserId(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('actor GitHub user ID must be a positive safe integer')
  }

  return String(value)
}

function normalizeComment(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }

  const normalized = value.trim()

  if (normalized.length === 0) {
    return null
  }

  if (normalized.length > 4_000 || normalized.includes('\u0000')) {
    throw new ProjectConfigurationValidationError(
      'invalid_qa_comment',
      'QA comment must contain at most 4000 characters and no NUL bytes',
    )
  }

  return normalized
}

function assertLocalId(value: string, name: string): void {
  if (value.trim().length === 0 || value.length > 128) {
    throw new TypeError(`${name} must contain 1-128 characters`)
  }
}

function assertCorrelationId(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new TypeError('correlation ID is invalid')
  }
}

function assertValidDate(value: Date): void {
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('QA assessment timestamp is invalid')
  }
}
