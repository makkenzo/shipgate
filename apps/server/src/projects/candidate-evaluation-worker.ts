import { createHash, randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseSchema, JsonValue } from '@shipgate/database'
import {
  PermanentJobError,
  type ReleaseCandidateEvaluationExecution,
  type ReleaseCandidateEvaluationHandler,
  RetryableJobError,
} from '@shipgate/jobs'
import type { Selectable, Transaction } from 'kysely'

import {
  type ProjectReleaseStateCoordinates,
  parseCandidateEvaluationReasons,
  queueActiveCandidateEvaluationInTransaction,
} from './candidate-evaluation-queue.js'
import {
  evaluateRelease,
  type ReleaseEvaluation,
  type ReleaseEvaluationChangeInput,
  type ReleaseEvaluationInput,
} from './release-evaluation.js'
import { withRepositoryTransaction } from './repository-transaction.js'

interface ClaimedCandidateEvaluation {
  readonly requestId: string
  readonly projectId: string
  readonly repositoryId: string
  readonly candidateId: string
  readonly projectStateVersion: number
  readonly projectionVersion: number
  readonly candidateVersion: number
  readonly configurationVersion: number
  readonly requiredCheckPolicyVersion: number
  readonly sourceSha: string
  readonly productionSha: string
  readonly reasons: readonly string[]
}

interface CandidateEvaluationSnapshot {
  readonly claim: ClaimedCandidateEvaluation
  readonly projectionFingerprint: string
  readonly input: ReleaseEvaluationInput
}

export function createReleaseCandidateEvaluationHandler(options: {
  readonly database: DatabaseClient
  readonly beforePublish?: (input: {
    readonly claim: ClaimedCandidateEvaluation
    readonly evaluation: ReleaseEvaluation
  }) => Promise<void>
}): ReleaseCandidateEvaluationHandler {
  return async (execution) => {
    const locator = await options.database.kysely
      .selectFrom('release_candidate_evaluation_requests')
      .select(['id', 'repository_id', 'status'])
      .where('id', '=', execution.requestId)
      .executeTakeFirst()

    if (!locator) {
      return { status: 'ignored', reason: 'request_not_found' }
    }

    if (isTerminalStatus(locator.status)) {
      return { status: locator.status, requestId: locator.id }
    }

    const claim = await withRepositoryTransaction(
      options.database,
      locator.repository_id,
      ({ transaction }) => claimCandidateEvaluation(transaction, execution),
    )

    if (!claim) {
      return { status: 'ignored', reason: 'request_no_longer_runnable' }
    }

    try {
      const snapshot = await loadCandidateEvaluationSnapshot(options.database, claim)

      if (!snapshot) {
        return withRepositoryTransaction(options.database, claim.repositoryId, ({ transaction }) =>
          discardCandidateEvaluation(transaction, claim, 'projection_unavailable'),
        )
      }

      const evaluation = evaluateRelease(snapshot.input)

      await options.beforePublish?.({ claim, evaluation })

      return await withRepositoryTransaction(
        options.database,
        claim.repositoryId,
        ({ transaction }) => publishCandidateEvaluation(transaction, snapshot, evaluation),
      )
    } catch (error) {
      const retryable = isRetryable(error)
      const exhausted = execution.attempt >= execution.maxAttempts

      await recordCandidateEvaluationFailure(options.database, claim, {
        error,
        attempt: execution.attempt,
        terminal: !retryable || exhausted,
      })

      if (retryable && !exhausted) {
        throw new RetryableJobError('Release candidate evaluation failed temporarily', {
          code: errorCode(error),
          details: { requestId: claim.requestId, projectId: claim.projectId },
          cause: error,
        })
      }

      throw new PermanentJobError('Release candidate evaluation failed permanently', {
        code: errorCode(error),
        details: { requestId: claim.requestId, projectId: claim.projectId },
        cause: error,
      })
    }
  }
}

async function claimCandidateEvaluation(
  transaction: Transaction<DatabaseSchema>,
  execution: ReleaseCandidateEvaluationExecution,
): Promise<ClaimedCandidateEvaluation | null> {
  const locator = await transaction
    .selectFrom('release_candidate_evaluation_requests')
    .select(['project_id', 'candidate_id'])
    .where('id', '=', execution.requestId)
    .executeTakeFirst()

  if (!locator) {
    return null
  }

  const project = await transaction
    .selectFrom('projects')
    .select(projectCoordinateColumns)
    .where('id', '=', locator.project_id)
    .forUpdate()
    .executeTakeFirst()
  const candidate = await transaction
    .selectFrom('release_candidates')
    .selectAll()
    .where('id', '=', locator.candidate_id)
    .forUpdate()
    .executeTakeFirst()
  const request = await transaction
    .selectFrom('release_candidate_evaluation_requests')
    .selectAll()
    .where('id', '=', execution.requestId)
    .forUpdate()
    .executeTakeFirst()

  if (!request || isTerminalStatus(request.status)) {
    return null
  }

  if (
    !project ||
    !candidate ||
    candidate.state !== 'open' ||
    project.repository_id !== request.repository_id ||
    candidate.project_id !== project.id ||
    candidate.repository_id !== project.repository_id ||
    !requestMatchesState(request, project, candidate.version)
  ) {
    await transaction
      .updateTable('release_candidate_evaluation_requests')
      .set({
        status: 'superseded',
        completed_at: new Date(),
        last_error_code: 'state_superseded',
        last_error_message: 'Project or candidate state changed before evaluation started',
        updated_at: new Date(),
      })
      .where('id', '=', execution.requestId)
      .where('status', 'in', ['queued', 'running'])
      .execute()

    if (
      project &&
      candidate?.state === 'open' &&
      project.repository_id === request.repository_id &&
      project.status !== 'pending_deletion' &&
      project.status !== 'deleted'
    ) {
      await queueActiveCandidateEvaluationInTransaction(transaction, {
        project,
        reason: 'state_changed_during_evaluation',
      })
    }

    return null
  }

  const claimedAt = request.claimed_at ?? new Date()

  await transaction
    .updateTable('release_candidate_evaluation_requests')
    .set({
      status: 'running',
      claimed_at: claimedAt,
      attempt_count: execution.attempt,
      last_error_code: null,
      last_error_message: null,
      updated_at: new Date(),
    })
    .where('id', '=', request.id)
    .where('status', 'in', ['queued', 'running'])
    .executeTakeFirstOrThrow()

  return {
    requestId: request.id,
    projectId: request.project_id,
    repositoryId: request.repository_id,
    candidateId: request.candidate_id,
    projectStateVersion: request.project_state_version,
    projectionVersion: request.projection_version,
    candidateVersion: request.candidate_version,
    configurationVersion: request.configuration_version,
    requiredCheckPolicyVersion: request.required_check_policy_version,
    sourceSha: request.source_sha,
    productionSha: request.production_sha,
    reasons: parseCandidateEvaluationReasons(request.reasons),
  }
}

async function loadCandidateEvaluationSnapshot(
  database: DatabaseClient,
  claim: ClaimedCandidateEvaluation,
): Promise<CandidateEvaluationSnapshot | null> {
  return database.kysely
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (transaction) => {
      const project = await transaction
        .selectFrom('projects')
        .select([...projectCoordinateColumns, 'installation_id'])
        .where('id', '=', claim.projectId)
        .executeTakeFirst()
      const candidate = await transaction
        .selectFrom('release_candidates')
        .select(['id', 'version', 'state'])
        .where('id', '=', claim.candidateId)
        .executeTakeFirst()

      if (
        !project ||
        !candidate ||
        candidate.state !== 'open' ||
        !coordinatesMatchClaim(project, candidate.version, claim)
      ) {
        return null
      }

      const [
        changes,
        qaRows,
        requiredChecks,
        checkRows,
        dependencies,
        exclusions,
        attributionRows,
        commitRows,
        installation,
      ] = await Promise.all([
        transaction
          .selectFrom('changes')
          .select([
            'id',
            'pull_request_number',
            'merged_at',
            'synchronization_state',
            'production_presence',
            'commit_set_fingerprint',
          ])
          .where('project_id', '=', project.id)
          .orderBy('merged_at')
          .orderBy('pull_request_number')
          .orderBy('id')
          .execute(),
        transaction
          .selectFrom('effective_change_qa_assessments')
          .select(['change_id', 'status'])
          .where('project_id', '=', project.id)
          .execute(),
        transaction
          .selectFrom('required_checks')
          .select(['id', 'context', 'integration_id'])
          .where('project_id', '=', project.id)
          .where('policy_version', '=', project.required_check_policy_version)
          .orderBy('context')
          .orderBy('integration_id')
          .orderBy('id')
          .execute(),
        transaction
          .selectFrom('change_required_check_states')
          .select(['change_id', 'required_check_id', 'state'])
          .where('project_id', '=', project.id)
          .where('policy_version', '=', project.required_check_policy_version)
          .orderBy('change_id')
          .orderBy('required_check_id')
          .execute(),
        transaction
          .selectFrom('change_dependencies')
          .select(['dependent_change_id', 'prerequisite_change_id'])
          .where('project_id', '=', project.id)
          .orderBy('dependent_change_id')
          .orderBy('prerequisite_change_id')
          .execute(),
        transaction
          .selectFrom('candidate_exclusions')
          .select('change_id')
          .where('candidate_id', '=', candidate.id)
          .orderBy('change_id')
          .execute(),
        transaction
          .selectFrom('change_commits as membership')
          .innerJoin('repository_commits as commit', (join) =>
            join
              .onRef('commit.project_id', '=', 'membership.project_id')
              .onRef('commit.repository_id', '=', 'membership.repository_id')
              .onRef('commit.sha', '=', 'membership.commit_sha'),
          )
          .select(['membership.change_id', 'commit.attribution_state'])
          .where('membership.project_id', '=', project.id)
          .execute(),
        transaction
          .selectFrom('repository_commits')
          .select(['sha', 'attribution_state'])
          .where('project_id', '=', project.id)
          .where('source_delta_position', 'is not', null)
          .orderBy('source_delta_position')
          .orderBy('sha')
          .execute(),
        transaction
          .selectFrom('github_installations as installation')
          .leftJoin('github_installation_repositories as repository', (join) =>
            join
              .onRef('repository.installation_id', '=', 'installation.installation_id')
              .on('repository.repository_id', '=', project.repository_id),
          )
          .select([
            'installation.lifecycle_state',
            'installation.permission_state',
            'repository.repository_id',
            'repository.archived',
            'repository.disabled',
          ])
          .where('installation.installation_id', '=', project.installation_id)
          .executeTakeFirst(),
      ])

      const qaByChange = new Map(qaRows.map((row) => [row.change_id, row.status] as const))
      const checkStateByChangeAndRequirement = new Map(
        checkRows.map(
          (row) => [`${row.change_id}\u0000${row.required_check_id}`, row.state] as const,
        ),
      )

      const attributionByChange = new Map<string, Array<'managed' | 'unmanaged' | 'ambiguous'>>()

      for (const row of attributionRows) {
        const current = attributionByChange.get(row.change_id) ?? []
        current.push(row.attribution_state)
        attributionByChange.set(row.change_id, current)
      }

      const normalizedChanges: ReleaseEvaluationChangeInput[] = changes.map((change) => ({
        id: change.id,
        pullRequestNumber: change.pull_request_number,
        mergedAt: change.merged_at.toISOString(),
        synchronizationState:
          change.synchronization_state === 'known' ? ('valid' as const) : ('unknown' as const),
        productionPresence: normalizeProductionPresence(change.production_presence),
        qaStatus: qaByChange.get(change.id) ?? 'pending',
        requiredChecks: requiredChecks.map((required) => ({
          name:
            required.integration_id === null
              ? required.context
              : `${required.context} [app:${required.integration_id}]`,
          state: normalizeRequiredCheckState(
            checkStateByChangeAndRequirement.get(`${change.id}\u0000${required.id}`) ?? 'missing',
          ),
        })),
        commitAttribution: summarizeAttribution(attributionByChange.get(change.id) ?? []),
        commitSetFingerprint: change.commit_set_fingerprint,
      }))
      const candidateChangeIds = normalizedChanges
        .filter((change) => change.productionPresence !== 'released')
        .map((change) => change.id)
      const candidateSet = new Set(candidateChangeIds)
      const excludedChangeIds = exclusions
        .map((exclusion) => exclusion.change_id)
        .filter((changeId) => candidateSet.has(changeId))
      const permissionGranted =
        installation?.lifecycle_state === 'active' &&
        installation.permission_state === 'current' &&
        installation.repository_id !== null &&
        installation.archived !== true &&
        installation.disabled !== true

      const evaluationInput: ReleaseEvaluationInput = {
        project: {
          status: project.status,
          permission: permissionGranted ? 'granted' : 'missing',
        },
        candidateChangeIds,
        excludedChangeIds,
        changes: normalizedChanges,
        dependencies: dependencies.map((dependency) => ({
          dependentChangeId: dependency.dependent_change_id,
          prerequisiteChangeId: dependency.prerequisite_change_id,
        })),
        unmanagedCommits: commitRows
          .filter((commit) => commit.attribution_state === 'unmanaged')
          .map((commit) => ({ sha: commit.sha })),
        ambiguousCommits: commitRows
          .filter((commit) => commit.attribution_state === 'ambiguous')
          .map((commit) => ({ sha: commit.sha })),
        expectedAgainst: {
          sourceSha: claim.sourceSha,
          productionSha: claim.productionSha,
        },
        evaluatedAgainst: {
          sourceSha: project.source_sha ?? claim.sourceSha,
          productionSha: project.production_sha ?? claim.productionSha,
          configurationVersion: project.configuration_version,
          projectionVersion: project.projection_version,
        },
      }

      return {
        claim,
        projectionFingerprint: createHash('sha256')
          .update(stableStringify(toJsonValue(evaluationInput)))
          .digest('hex'),
        input: evaluationInput,
      }
    })
}

async function publishCandidateEvaluation(
  transaction: Transaction<DatabaseSchema>,
  snapshot: CandidateEvaluationSnapshot,
  evaluation: ReleaseEvaluation,
): Promise<JsonValue> {
  const project = await transaction
    .selectFrom('projects')
    .select(projectCoordinateColumns)
    .where('id', '=', snapshot.claim.projectId)
    .forUpdate()
    .executeTakeFirst()
  const candidate = await transaction
    .selectFrom('release_candidates')
    .selectAll()
    .where('id', '=', snapshot.claim.candidateId)
    .forUpdate()
    .executeTakeFirst()
  const request = await transaction
    .selectFrom('release_candidate_evaluation_requests')
    .selectAll()
    .where('id', '=', snapshot.claim.requestId)
    .forUpdate()
    .executeTakeFirst()

  if (
    !project ||
    !candidate ||
    !request ||
    request.status !== 'running' ||
    candidate.state !== 'open' ||
    !coordinatesMatchClaim(project, candidate.version, snapshot.claim) ||
    !requestMatchesState(request, project, candidate.version)
  ) {
    return discardCandidateEvaluation(
      transaction,
      snapshot.claim,
      'state_changed_during_evaluation',
      project ?? undefined,
    )
  }

  const latestEvaluation = await transaction
    .selectFrom('release_candidate_evaluations')
    .select('result')
    .where('candidate_id', '=', candidate.id)
    .orderBy('evaluation_version', 'desc')
    .executeTakeFirst()
  const maxVersion = await transaction
    .selectFrom('release_candidate_evaluations')
    .select(({ fn }) => fn.max<number>('evaluation_version').as('version'))
    .where('candidate_id', '=', candidate.id)
    .executeTakeFirst()
  const evaluationVersion = (maxVersion?.version ?? 0) + 1
  const evaluatedAt = new Date()
  const evaluationJson = toJsonValue(evaluation)
  const fingerprint = createHash('sha256').update(stableStringify(evaluationJson)).digest('hex')
  const evaluationId = randomUUID()

  await transaction
    .insertInto('release_candidate_evaluations')
    .values({
      id: evaluationId,
      candidate_id: candidate.id,
      project_id: project.id,
      repository_id: project.repository_id,
      evaluation_version: evaluationVersion,
      candidate_version: candidate.version,
      request_id: request.id,
      project_state_version: project.release_state_version,
      projection_version: project.projection_version,
      configuration_version: project.configuration_version,
      source_sha: snapshot.claim.sourceSha,
      production_sha: snapshot.claim.productionSha,
      projection_fingerprint: snapshot.projectionFingerprint,
      required_check_policy_version: project.required_check_policy_version,
      result: evaluation.status,
      evaluation_fingerprint: fingerprint,
      summary: JSON.stringify(evaluationJson),
      blockers: JSON.stringify(toJsonValue(evaluation.blockers)),
      evaluated_at: evaluatedAt,
    })
    .execute()

  await transaction
    .updateTable('release_candidates')
    .set({
      latest_evaluation_version: evaluationVersion,
      evaluation_status: evaluation.status,
      updated_at: evaluatedAt,
    })
    .where('id', '=', candidate.id)
    .where('version', '=', candidate.version)
    .executeTakeFirstOrThrow()

  await transaction
    .updateTable('release_candidate_evaluation_requests')
    .set({
      status: 'succeeded',
      completed_at: evaluatedAt,
      last_error_code: null,
      last_error_message: null,
      updated_at: evaluatedAt,
    })
    .where('id', '=', request.id)
    .where('status', '=', 'running')
    .executeTakeFirstOrThrow()

  if (latestEvaluation && latestEvaluation.result !== evaluation.status) {
    await transaction
      .insertInto('audit_events')
      .values({
        id: randomUUID(),
        project_id: project.id,
        repository_id: project.repository_id,
        actor_github_user_id: null,
        event_type: 'candidate_status_changed',
        source: 'system',
        configuration_version: project.configuration_version,
        entity_type: 'release_candidate',
        entity_id: candidate.id,
        correlation_id: null,
        reason_code: 'semantic_outcome_changed',
        before_state: JSON.stringify({ status: latestEvaluation.result }),
        after_state: JSON.stringify({ status: evaluation.status }),
        payload: JSON.stringify({
          evaluationId,
          evaluationVersion,
          projectStateVersion: project.release_state_version,
          projectionVersion: project.projection_version,
        } satisfies JsonValue),
        occurred_at: evaluatedAt,
      })
      .execute()
  }

  return {
    status: 'published',
    requestId: request.id,
    candidateId: candidate.id,
    evaluationId,
    evaluationVersion,
    result: evaluation.status,
    coalescedReasons: snapshot.claim.reasons,
  }
}

async function discardCandidateEvaluation(
  transaction: Transaction<DatabaseSchema>,
  claim: ClaimedCandidateEvaluation,
  reason: string,
  currentProject?: ProjectReleaseStateCoordinates,
): Promise<JsonValue> {
  const now = new Date()

  await transaction
    .updateTable('release_candidate_evaluation_requests')
    .set({
      status: 'superseded',
      completed_at: now,
      last_error_code: reason,
      last_error_message:
        'Evaluation result was discarded because its input state is no longer current',
      updated_at: now,
    })
    .where('id', '=', claim.requestId)
    .where('status', 'in', ['queued', 'running'])
    .execute()

  const project =
    currentProject ??
    (await transaction
      .selectFrom('projects')
      .select(projectCoordinateColumns)
      .where('id', '=', claim.projectId)
      .forUpdate()
      .executeTakeFirst())

  if (
    project &&
    project.status !== 'pending_deletion' &&
    project.status !== 'deleted' &&
    project.source_sha !== null &&
    project.production_sha !== null &&
    project.last_successful_sync_at !== null
  ) {
    const candidate = await transaction
      .selectFrom('release_candidates')
      .select(['id', 'version', 'state', 'latest_evaluation_version'])
      .where('id', '=', claim.candidateId)
      .forUpdate()
      .executeTakeFirst()
    const coveredByNewerState = await hasCurrentEvaluationOrRequest(transaction, {
      project,
      candidate,
      supersededRequestId: claim.requestId,
    })

    if (!coveredByNewerState) {
      await queueActiveCandidateEvaluationInTransaction(transaction, {
        project,
        reason: 'state_changed_during_evaluation',
        now,
      })
    }
  }

  return { status: 'discarded', requestId: claim.requestId, reason }
}

async function hasCurrentEvaluationOrRequest(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly project: ProjectReleaseStateCoordinates
    readonly candidate:
      | {
          readonly id: string
          readonly version: number
          readonly state: Selectable<DatabaseSchema['release_candidates']>['state']
          readonly latest_evaluation_version: number | null
        }
      | undefined
    readonly supersededRequestId: string
  },
): Promise<boolean> {
  const candidate = input.candidate

  if (candidate?.state !== 'open') {
    return true
  }

  if (candidate.latest_evaluation_version !== null) {
    const evaluation = await transaction
      .selectFrom('release_candidate_evaluations')
      .select([
        'candidate_version',
        'configuration_version',
        'source_sha',
        'production_sha',
        'project_state_version',
        'projection_version',
        'required_check_policy_version',
      ])
      .where('candidate_id', '=', candidate.id)
      .where('evaluation_version', '=', candidate.latest_evaluation_version)
      .executeTakeFirst()

    if (
      evaluation &&
      evaluation.candidate_version === candidate.version &&
      evaluation.configuration_version === input.project.configuration_version &&
      evaluation.source_sha === input.project.source_sha &&
      evaluation.production_sha === input.project.production_sha &&
      evaluation.project_state_version === input.project.release_state_version &&
      evaluation.projection_version === input.project.projection_version &&
      evaluation.required_check_policy_version === input.project.required_check_policy_version
    ) {
      return true
    }
  }

  const request = await transaction
    .selectFrom('release_candidate_evaluation_requests')
    .select('id')
    .where('id', '<>', input.supersededRequestId)
    .where('project_id', '=', input.project.id)
    .where('candidate_id', '=', candidate.id)
    .where('status', 'in', ['queued', 'running'])
    .where('project_state_version', '=', input.project.release_state_version)
    .where('projection_version', '=', input.project.projection_version)
    .where('candidate_version', '=', candidate.version)
    .where('configuration_version', '=', input.project.configuration_version)
    .where('required_check_policy_version', '=', input.project.required_check_policy_version)
    .where('source_sha', '=', input.project.source_sha)
    .where('production_sha', '=', input.project.production_sha)
    .executeTakeFirst()

  return request !== undefined
}

async function recordCandidateEvaluationFailure(
  database: DatabaseClient,
  claim: ClaimedCandidateEvaluation,
  input: { readonly error: unknown; readonly attempt: number; readonly terminal: boolean },
): Promise<void> {
  await withRepositoryTransaction(database, claim.repositoryId, async ({ transaction }) => {
    const project = await transaction
      .selectFrom('projects')
      .select('id')
      .where('id', '=', claim.projectId)
      .forUpdate()
      .executeTakeFirst()
    await transaction
      .selectFrom('release_candidates')
      .select('id')
      .where('id', '=', claim.candidateId)
      .forUpdate()
      .executeTakeFirst()
    const request = await transaction
      .selectFrom('release_candidate_evaluation_requests')
      .select(['id', 'status'])
      .where('id', '=', claim.requestId)
      .forUpdate()
      .executeTakeFirst()

    if (!project || !request || isTerminalStatus(request.status)) {
      return
    }

    const now = new Date()

    await transaction
      .updateTable('release_candidate_evaluation_requests')
      .set({
        status: input.terminal ? 'failed' : 'running',
        attempt_count: input.attempt,
        last_error_code: errorCode(input.error),
        last_error_message: toError(input.error).message.slice(0, 4_000),
        completed_at: input.terminal ? now : null,
        updated_at: now,
      })
      .where('id', '=', request.id)
      .where('status', 'in', ['queued', 'running'])
      .execute()
  })
}

function coordinatesMatchClaim(
  project: ProjectReleaseStateCoordinates,
  candidateVersion: number,
  claim: ClaimedCandidateEvaluation,
): boolean {
  return (
    project.repository_id === claim.repositoryId &&
    project.release_state_version === claim.projectStateVersion &&
    project.projection_version === claim.projectionVersion &&
    project.configuration_version === claim.configurationVersion &&
    project.required_check_policy_version === claim.requiredCheckPolicyVersion &&
    project.source_sha === claim.sourceSha &&
    project.production_sha === claim.productionSha &&
    candidateVersion === claim.candidateVersion
  )
}

function requestMatchesState(
  request: Selectable<DatabaseSchema['release_candidate_evaluation_requests']>,
  project: ProjectReleaseStateCoordinates,
  candidateVersion: number,
): boolean {
  return (
    request.project_id === project.id &&
    request.repository_id === project.repository_id &&
    request.project_state_version === project.release_state_version &&
    request.projection_version === project.projection_version &&
    request.candidate_version === candidateVersion &&
    request.configuration_version === project.configuration_version &&
    request.required_check_policy_version === project.required_check_policy_version &&
    request.source_sha === project.source_sha &&
    request.production_sha === project.production_sha
  )
}

function normalizeProductionPresence(
  value: Selectable<DatabaseSchema['changes']>['production_presence'],
): ReleaseEvaluationChangeInput['productionPresence'] {
  switch (value) {
    case 'unreleased':
      return 'unreleased'
    case 'released':
      return 'released'
    case 'partially_present':
      return 'partially_released'
    case 'unknown':
      return 'unknown'
  }
}

function normalizeRequiredCheckState(
  value: Selectable<DatabaseSchema['change_required_check_states']>['state'],
): 'successful' | 'pending' | 'failed' | 'missing' {
  return value === 'stale' ? 'pending' : value
}

function summarizeAttribution(
  states: readonly ('managed' | 'unmanaged' | 'ambiguous')[],
): 'managed' | 'unmanaged' | 'ambiguous' {
  if (states.length === 0 || states.includes('ambiguous')) return 'ambiguous'
  if (states.includes('unmanaged')) return 'unmanaged'
  return 'managed'
}

function stableStringify(value: JsonValue): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson)
  if (typeof value !== 'object' || value === null) return value

  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  )
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function isTerminalStatus(value: string): boolean {
  return value === 'succeeded' || value === 'superseded' || value === 'failed'
}

function isRetryable(value: unknown): boolean {
  return !(value instanceof TypeError || value instanceof PermanentJobError)
}

function errorCode(value: unknown): string {
  if (value instanceof PermanentJobError || value instanceof RetryableJobError) {
    return value.code
  }

  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = Reflect.get(value, 'code')
    if (typeof code === 'string' && code.length > 0) return code.toLowerCase()
  }

  return 'release_candidate_evaluation_failed'
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
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
