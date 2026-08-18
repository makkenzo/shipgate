import { randomUUID } from 'node:crypto'

import type {
  DatabaseSchema,
  JsonValue,
  ProjectAuditSource,
  RequiredCheckSource,
} from '@shipgate/database'
import type { Kysely, Selectable, Transaction } from 'kysely'

import { touchProjectReleaseStateAndQueueEvaluation } from './candidate-evaluation-queue.js'
import { ProjectNotFoundError, ProjectVersionConflictError } from './errors.js'
import type {
  ChangeRequiredCheckState,
  CommitCheckResultProjection,
  RequiredCheckObservation,
  RequiredCheckProjection,
} from './model.js'
import {
  assertRepositoryTransaction,
  type RepositoryTransaction,
  serializeGitHubNumericId,
} from './repository-transaction.js'
import { resolveRequiredCheck } from './required-checks.js'

export interface RequiredCheckProjectionTrigger {
  readonly reason: string
  readonly auditSource: ProjectAuditSource
  readonly actorGitHubUserId: number | string | null
  readonly deliveryId?: string
  readonly auditWhenUnchanged?: boolean
}

export interface ApplyRequiredCheckProjectionInput {
  readonly projectId: string
  readonly repositoryId: number | string
  readonly expectedConfigurationVersion: number
  readonly requiredChecks: readonly RequiredCheckProjection[]
  readonly checkResults: readonly CommitCheckResultProjection[]
  readonly targetCommitShas: readonly string[]
  readonly recomputeAllChanges: boolean
  readonly observedAt: Date
  readonly trigger: RequiredCheckProjectionTrigger
  readonly suppressCandidateReevaluation?: boolean
}

export interface ApplyRequiredCheckProjectionResult {
  readonly policyVersion: number
  readonly policyChanged: boolean
  readonly changeCount: number
  readonly stateCount: number
}

export async function applyRequiredCheckProjectionInTransaction(
  scope: RepositoryTransaction,
  input: ApplyRequiredCheckProjectionInput,
): Promise<ApplyRequiredCheckProjectionResult> {
  const repositoryId = assertRepositoryTransaction(scope, input.repositoryId)
  const transaction = scope.transaction
  const project = await transaction
    .selectFrom('projects')
    .select([
      'id',
      'repository_id',
      'configuration_version',
      'required_check_policy_version',
      'status',
    ])
    .where('id', '=', input.projectId)
    .forUpdate()
    .executeTakeFirst()

  if (!project || project.status === 'deleted' || project.repository_id !== repositoryId) {
    throw new ProjectNotFoundError(input.projectId)
  }

  if (project.configuration_version !== input.expectedConfigurationVersion) {
    throw new ProjectVersionConflictError(
      project.id,
      input.expectedConfigurationVersion,
      project.configuration_version,
    )
  }

  const previousEvaluationFingerprint = input.suppressCandidateReevaluation
    ? null
    : await loadRequiredCheckEvaluationFingerprint(transaction, project.id)
  const policy = await applyPolicySnapshot(transaction, {
    projectId: project.id,
    repositoryId,
    currentVersion: project.required_check_policy_version,
    configurationVersion: project.configuration_version,
    requiredChecks: input.requiredChecks,
    observedAt: input.observedAt,
    trigger: input.trigger,
  })

  await replaceCheckResults(transaction, {
    projectId: project.id,
    repositoryId,
    targetCommitShas: input.targetCommitShas,
    results: input.checkResults,
    pruneUntargetedResults: input.recomputeAllChanges,
    observedAt: input.observedAt,
  })

  const changes = await loadTargetChanges(transaction, {
    projectId: project.id,
    targetCommitShas: input.targetCommitShas,
    recomputeAllChanges: input.recomputeAllChanges || policy.changed,
  })
  const requiredChecks = await loadPolicyRows(transaction, project.id, policy.version)
  const stateCount = await replaceChangeStates(transaction, {
    projectId: project.id,
    repositoryId,
    policyVersion: policy.version,
    replaceAllStates: input.recomputeAllChanges || policy.changed,
    changes,
    requiredChecks,
    observedAt: input.observedAt,
  })

  if (!input.suppressCandidateReevaluation) {
    const currentEvaluationFingerprint = await loadRequiredCheckEvaluationFingerprint(
      transaction,
      project.id,
    )

    if (previousEvaluationFingerprint !== currentEvaluationFingerprint) {
      await touchProjectReleaseStateAndQueueEvaluation(scope, {
        projectId: project.id,
        repositoryId,
        reason: policy.changed ? 'required_checks_changed' : 'check_result_changed',
        now: input.observedAt,
      })
    }
  }

  return {
    policyVersion: policy.version,
    policyChanged: policy.changed,
    changeCount: changes.length,
    stateCount,
  }
}

export async function loadRequiredCheckStatesForChanges(
  database: Kysely<DatabaseSchema>,
  changeIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ChangeRequiredCheckState[]>> {
  if (changeIds.length === 0) {
    return new Map()
  }

  const rows = await database
    .selectFrom('change_required_check_states as state')
    .innerJoin('required_checks as required', 'required.id', 'state.required_check_id')
    .select([
      'state.change_id',
      'state.required_check_id',
      'state.policy_version',
      'state.commit_sha',
      'state.state',
      'state.evidence_ids',
      'state.observed_at',
      'required.context',
      'required.integration_id',
      'required.source',
      'required.source_reference',
    ])
    .where('state.change_id', 'in', changeIds)
    .orderBy('state.change_id')
    .orderBy('required.context')
    .orderBy('required.integration_id')
    .orderBy('required.source')
    .execute()
  const evidenceIds = new Set(rows.flatMap((row) => parseEvidenceIds(row.evidence_ids)))
  const evidenceRows =
    evidenceIds.size === 0
      ? []
      : await database
          .selectFrom('commit_check_results')
          .selectAll()
          .where('id', 'in', [...evidenceIds])
          .execute()
  const evidenceById = new Map(evidenceRows.map((row) => [row.id, mapObservation(row)] as const))
  const grouped = new Map<string, ChangeRequiredCheckState[]>()

  for (const row of rows) {
    const states = grouped.get(row.change_id) ?? []
    const observations = parseEvidenceIds(row.evidence_ids)
      .map((id) => evidenceById.get(id))
      .filter((observation): observation is RequiredCheckObservation => observation !== undefined)

    states.push({
      requiredCheckId: row.required_check_id,
      policyVersion: row.policy_version,
      context: row.context,
      integrationId: parseNullableGitHubId(row.integration_id),
      source: row.source,
      sourceReference: row.source_reference,
      commitSha: row.commit_sha,
      state: row.state,
      observations,
      observedAt: row.observed_at,
    })
    grouped.set(row.change_id, states)
  }

  return grouped
}

async function applyPolicySnapshot(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly projectId: string
    readonly repositoryId: string
    readonly currentVersion: number
    readonly configurationVersion: number
    readonly requiredChecks: readonly RequiredCheckProjection[]
    readonly observedAt: Date
    readonly trigger: RequiredCheckProjectionTrigger
  },
): Promise<{ readonly version: number; readonly changed: boolean }> {
  const currentRows =
    input.currentVersion === 0
      ? []
      : await transaction
          .selectFrom('required_checks')
          .select(['context', 'integration_id', 'source', 'source_reference'])
          .where('project_id', '=', input.projectId)
          .where('policy_version', '=', input.currentVersion)
          .execute()
  const previous = currentRows.map(mapPolicyIdentity).toSorted(comparePolicyIdentity)
  const current = input.requiredChecks.map(normalizePolicyIdentity).toSorted(comparePolicyIdentity)
  const changed = input.currentVersion === 0 || JSON.stringify(previous) !== JSON.stringify(current)

  if (!changed) {
    if (input.trigger.auditWhenUnchanged) {
      await insertPolicyAuditEvent(transaction, {
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        configurationVersion: input.configurationVersion,
        eventType: 'required_check_policy_refreshed',
        previousPolicyVersion: input.currentVersion,
        policyVersion: input.currentVersion,
        previous,
        current,
        trigger: input.trigger,
        observedAt: input.observedAt,
      })
    }

    return { version: input.currentVersion, changed: false }
  }

  const version = input.currentVersion + 1

  if (input.requiredChecks.length > 0) {
    await transaction
      .insertInto('required_checks')
      .values(
        input.requiredChecks.map((check) => ({
          id: randomUUID(),
          project_id: input.projectId,
          repository_id: input.repositoryId,
          policy_version: version,
          context: check.context,
          integration_id:
            check.integrationId === null
              ? null
              : serializeGitHubNumericId(check.integrationId, 'required check integration ID'),
          source: check.source,
          source_reference: check.sourceReference,
          observed_at: input.observedAt,
          updated_at: input.observedAt,
        })),
      )
      .execute()
  }

  await transaction
    .updateTable('projects')
    .set({ required_check_policy_version: version, updated_at: input.observedAt })
    .where('id', '=', input.projectId)
    .where('configuration_version', '=', input.configurationVersion)
    .executeTakeFirstOrThrow()

  await insertPolicyAuditEvent(transaction, {
    projectId: input.projectId,
    repositoryId: input.repositoryId,
    configurationVersion: input.configurationVersion,
    eventType: 'required_check_policy_changed',
    previousPolicyVersion: input.currentVersion,
    policyVersion: version,
    previous,
    current,
    trigger: input.trigger,
    observedAt: input.observedAt,
  })

  return { version, changed: true }
}

async function insertPolicyAuditEvent(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly projectId: string
    readonly repositoryId: string
    readonly configurationVersion: number
    readonly eventType: 'required_check_policy_changed' | 'required_check_policy_refreshed'
    readonly previousPolicyVersion: number
    readonly policyVersion: number
    readonly previous: readonly ReturnType<typeof normalizePolicyIdentity>[]
    readonly current: readonly ReturnType<typeof normalizePolicyIdentity>[]
    readonly trigger: RequiredCheckProjectionTrigger
    readonly observedAt: Date
  },
): Promise<void> {
  await transaction
    .insertInto('audit_events')
    .values({
      id: randomUUID(),
      project_id: input.projectId,
      repository_id: input.repositoryId,
      actor_github_user_id:
        input.trigger.actorGitHubUserId === null
          ? null
          : serializeGitHubNumericId(input.trigger.actorGitHubUserId, 'audit actor GitHub user ID'),
      event_type: input.eventType,
      source: input.trigger.auditSource,
      configuration_version: input.configurationVersion,
      entity_type: 'project',
      entity_id: input.projectId,
      correlation_id: null,
      reason_code: input.trigger.reason,
      before_state: JSON.stringify({
        policyVersion: input.previousPolicyVersion,
        checks: input.previous,
      }),
      after_state: JSON.stringify({
        policyVersion: input.policyVersion,
        checks: input.current,
      }),
      payload: JSON.stringify({
        reason: input.trigger.reason,
        previousPolicyVersion: input.previousPolicyVersion,
        policyVersion: input.policyVersion,
        previous: input.previous,
        current: input.current,
        ...(input.trigger.deliveryId ? { deliveryId: input.trigger.deliveryId } : {}),
      } satisfies JsonValue),
      occurred_at: input.observedAt,
    })
    .execute()
}

async function replaceCheckResults(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly projectId: string
    readonly repositoryId: string
    readonly targetCommitShas: readonly string[]
    readonly results: readonly CommitCheckResultProjection[]
    readonly pruneUntargetedResults: boolean
    readonly observedAt: Date
  },
): Promise<void> {
  const targetCommitShas = [...new Set(input.targetCommitShas)]

  if (input.pruneUntargetedResults) {
    let prune = transaction
      .deleteFrom('commit_check_results')
      .where('project_id', '=', input.projectId)

    if (targetCommitShas.length > 0) {
      prune = prune.where('commit_sha', 'not in', targetCommitShas)
    }

    await prune.execute()
  }

  if (targetCommitShas.length > 0) {
    await transaction
      .deleteFrom('commit_check_results')
      .where('project_id', '=', input.projectId)
      .where('commit_sha', 'in', targetCommitShas)
      .execute()
  }

  if (input.results.length === 0) {
    return
  }

  await transaction
    .insertInto('commit_check_results')
    .values(
      input.results.map((result) => ({
        id: result.id ?? randomUUID(),
        project_id: input.projectId,
        repository_id: input.repositoryId,
        commit_sha: result.commitSha,
        check_type: result.type,
        context: result.context,
        integration_id:
          result.integrationId === null
            ? null
            : serializeGitHubNumericId(result.integrationId, 'check result integration ID'),
        github_object_id: serializeGitHubNumericId(
          result.githubObjectId,
          'check result GitHub object ID',
        ),
        attempt: result.attempt,
        status: result.status,
        conclusion: result.conclusion,
        details_url: result.detailsUrl,
        started_at: result.startedAt,
        completed_at: result.completedAt,
        observed_at: result.observedAt,
        updated_at: input.observedAt,
      })),
    )
    .execute()
}

async function loadTargetChanges(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly projectId: string
    readonly targetCommitShas: readonly string[]
    readonly recomputeAllChanges: boolean
  },
): Promise<readonly { readonly id: string; readonly final_head_sha: string }[]> {
  let query = transaction
    .selectFrom('changes')
    .select(['id', 'final_head_sha'])
    .where('project_id', '=', input.projectId)
    .where('synchronization_state', '=', 'known')
    .where('production_presence', 'in', ['unreleased', 'partially_present'])

  if (!input.recomputeAllChanges) {
    const targetCommitShas = [...new Set(input.targetCommitShas)]

    if (targetCommitShas.length === 0) {
      return []
    }

    query = query.where('final_head_sha', 'in', targetCommitShas)
  }

  return query.orderBy('merged_at').orderBy('pull_request_number').execute()
}

async function loadPolicyRows(
  transaction: Transaction<DatabaseSchema>,
  projectId: string,
  policyVersion: number,
): Promise<readonly Selectable<DatabaseSchema['required_checks']>[]> {
  return transaction
    .selectFrom('required_checks')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('policy_version', '=', policyVersion)
    .orderBy('context')
    .orderBy('integration_id')
    .orderBy('source')
    .execute()
}

async function replaceChangeStates(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly projectId: string
    readonly repositoryId: string
    readonly policyVersion: number
    readonly replaceAllStates: boolean
    readonly changes: readonly { readonly id: string; readonly final_head_sha: string }[]
    readonly requiredChecks: readonly Selectable<DatabaseSchema['required_checks']>[]
    readonly observedAt: Date
  },
): Promise<number> {
  if (input.replaceAllStates) {
    await transaction
      .deleteFrom('change_required_check_states')
      .where('project_id', '=', input.projectId)
      .execute()
  } else if (input.changes.length > 0) {
    await transaction
      .deleteFrom('change_required_check_states')
      .where(
        'change_id',
        'in',
        input.changes.map((change) => change.id),
      )
      .execute()
  }

  if (input.changes.length === 0 || input.requiredChecks.length === 0) {
    return 0
  }

  const shas = [...new Set(input.changes.map((change) => change.final_head_sha))]
  const resultRows = await transaction
    .selectFrom('commit_check_results')
    .selectAll()
    .where('project_id', '=', input.projectId)
    .where('commit_sha', 'in', shas)
    .execute()
  const resultsBySha = new Map<string, CommitCheckResultProjection[]>()

  for (const row of resultRows) {
    const results = resultsBySha.get(row.commit_sha) ?? []
    results.push(mapResult(row))
    resultsBySha.set(row.commit_sha, results)
  }

  const rows = input.changes.flatMap((change) =>
    input.requiredChecks.map((required) => {
      const resolution = resolveRequiredCheck(
        {
          context: required.context,
          integrationId: parseNullableGitHubId(required.integration_id),
        },
        resultsBySha.get(change.final_head_sha) ?? [],
      )

      return {
        project_id: input.projectId,
        repository_id: input.repositoryId,
        change_id: change.id,
        required_check_id: required.id,
        policy_version: input.policyVersion,
        commit_sha: change.final_head_sha,
        state: resolution.state,
        evidence_ids: JSON.stringify(
          resolution.observations
            .map((observation) => observation.id)
            .filter((id): id is string => id !== null),
        ),
        observed_at: input.observedAt,
        updated_at: input.observedAt,
      }
    }),
  )

  await transaction.insertInto('change_required_check_states').values(rows).execute()
  return rows.length
}

async function loadRequiredCheckEvaluationFingerprint(
  transaction: Transaction<DatabaseSchema>,
  projectId: string,
): Promise<string> {
  const project = await transaction
    .selectFrom('projects')
    .select('required_check_policy_version')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow()
  const checks = await transaction
    .selectFrom('required_checks')
    .select(['id', 'context', 'integration_id', 'source', 'source_reference'])
    .where('project_id', '=', projectId)
    .where('policy_version', '=', project.required_check_policy_version)
    .orderBy('context')
    .orderBy('integration_id')
    .orderBy('source')
    .execute()
  const states = await transaction
    .selectFrom('change_required_check_states')
    .select(['change_id', 'required_check_id', 'policy_version', 'commit_sha', 'state'])
    .where('project_id', '=', projectId)
    .where('policy_version', '=', project.required_check_policy_version)
    .orderBy('change_id')
    .orderBy('required_check_id')
    .execute()

  return JSON.stringify({
    policyVersion: project.required_check_policy_version,
    checks,
    states,
  })
}

function mapResult(
  row: Selectable<DatabaseSchema['commit_check_results']>,
): CommitCheckResultProjection {
  return {
    id: row.id,
    commitSha: row.commit_sha,
    type: row.check_type,
    context: row.context,
    integrationId: row.integration_id,
    githubObjectId: row.github_object_id,
    attempt: row.attempt,
    status: row.status,
    conclusion: row.conclusion,
    detailsUrl: row.details_url,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    observedAt: row.observed_at,
  }
}

function mapObservation(
  row: Selectable<DatabaseSchema['commit_check_results']>,
): RequiredCheckObservation {
  return {
    id: row.id,
    type: row.check_type,
    integrationId: parseNullableGitHubId(row.integration_id),
    githubObjectId: row.github_object_id,
    attempt: row.attempt,
    status: row.status,
    conclusion: row.conclusion,
    detailsUrl: row.details_url,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    observedAt: row.observed_at,
  }
}

function mapPolicyIdentity(row: {
  readonly context: string
  readonly integration_id: string | null
  readonly source: RequiredCheckSource
  readonly source_reference: string | null
}) {
  return {
    context: row.context,
    integrationId: parseNullableGitHubId(row.integration_id),
    source: row.source,
    sourceReference: row.source_reference,
  }
}

function normalizePolicyIdentity(check: RequiredCheckProjection) {
  return {
    context: check.context,
    integrationId: check.integrationId,
    source: check.source,
    sourceReference: check.sourceReference,
  }
}

function comparePolicyIdentity(
  left: ReturnType<typeof normalizePolicyIdentity>,
  right: ReturnType<typeof normalizePolicyIdentity>,
): number {
  return (
    left.context.localeCompare(right.context) ||
    (left.integrationId ?? 0) - (right.integrationId ?? 0) ||
    left.source.localeCompare(right.source) ||
    (left.sourceReference ?? '').localeCompare(right.sourceReference ?? '')
  )
}

function parseNullableGitHubId(value: string | null): number | null {
  if (value === null) {
    return null
  }

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Stored GitHub numeric ID is invalid: ${value}`)
  }

  return parsed
}

function parseEvidenceIds(value: JsonValue): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('Stored required-check evidence IDs are invalid')
  }

  return value
}
