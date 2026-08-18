import { createHash, randomUUID } from 'node:crypto'

import type {
  ChangeProductionPresence,
  DatabaseClient,
  DatabaseSchema,
  JsonValue,
  ProjectTable,
} from '@shipgate/database'
import { type Kysely, type Selectable, sql, type Transaction } from 'kysely'
import { queueActiveCandidateEvaluationInTransaction } from './candidate-evaluation-queue.js'
import { summarizeProjectCheckState } from './dashboard.js'
import {
  ProjectNotFoundError,
  ProjectRepositoryUnavailableError,
  ProjectVersionConflictError,
  RepositoryAlreadyConnectedError,
  RepositoryProjectionIdempotencyConflictError,
  RepositoryProjectionInvariantError,
} from './errors.js'
import type {
  ApplyRepositoryProjectionInput,
  ApplyRepositoryProjectionResult,
  ChangeAheadOfProduction,
  ChangeProjection,
  ChangeQaState,
  CreateProjectInput,
  ProjectRecord,
  RecordRepositorySyncFailureInput,
  RecordRepositorySyncFailureResult,
  RepositoryProjectionSnapshot,
  RepositorySyncIssueProjection,
  UnmanagedCommitRecord,
} from './model.js'
import {
  assertRepositoryTransaction,
  type RepositoryTransaction,
  serializeGitHubNumericId,
  withRepositoryTransaction,
} from './repository-transaction.js'
import { normalizeRequiredCheckOverrides, parseRequiredCheckOverrides } from './required-checks.js'
import {
  applyRequiredCheckProjectionInTransaction,
  loadRequiredCheckStatesForChanges,
} from './required-checks-store.js'

export async function createProject(
  database: DatabaseClient,
  input: CreateProjectInput,
): Promise<ProjectRecord> {
  const installationId = serializeGitHubNumericId(input.installationId, 'installation ID')
  const repositoryId = serializeGitHubNumericId(input.repositoryId, 'repository ID')
  const sourceBranch = assertBranchName(input.sourceBranch, 'source branch')
  const productionBranch = assertBranchName(input.productionBranch, 'production branch')
  const projectId = input.projectId ?? randomUUID()
  const now = input.now ?? new Date()

  assertLocalId(projectId, 'project ID')
  assertValidDate(now, 'project creation time')

  if (sourceBranch === productionBranch) {
    throw new RepositoryProjectionInvariantError('Source and production branches must differ')
  }

  return withRepositoryTransaction(database, repositoryId, async ({ transaction }) => {
    const existing = await transaction
      .selectFrom('projects')
      .select(['id'])
      .where('repository_id', '=', repositoryId)
      .where('status', '<>', 'deleted')
      .executeTakeFirst()

    if (existing) {
      throw new RepositoryAlreadyConnectedError(repositoryId, existing.id)
    }

    const repository = await transaction
      .selectFrom('github_installation_repositories as repository')
      .innerJoin(
        'github_installations as installation',
        'installation.installation_id',
        'repository.installation_id',
      )
      .select([
        'repository.owner_id',
        'repository.owner_login',
        'repository.name',
        'repository.full_name',
        'repository.default_branch',
        'repository.archived',
        'repository.disabled',
        'installation.lifecycle_state',
      ])
      .where('repository.installation_id', '=', installationId)
      .where('repository.repository_id', '=', repositoryId)
      .executeTakeFirst()

    if (!repository) {
      throw new ProjectRepositoryUnavailableError(
        installationId,
        repositoryId,
        'repository is not selected in the installation',
      )
    }

    if (repository.lifecycle_state !== 'active') {
      throw new ProjectRepositoryUnavailableError(
        installationId,
        repositoryId,
        `installation lifecycle is ${repository.lifecycle_state}`,
      )
    }

    if (repository.archived || repository.disabled) {
      throw new ProjectRepositoryUnavailableError(
        installationId,
        repositoryId,
        repository.archived ? 'repository is archived' : 'repository is disabled',
      )
    }

    const row = await transaction
      .insertInto('projects')
      .values({
        id: projectId,
        installation_id: installationId,
        repository_id: repositoryId,
        owner_id: repository.owner_id,
        owner_login: repository.owner_login,
        repository_name: repository.name,
        repository_full_name: repository.full_name,
        default_branch: repository.default_branch,
        source_branch: sourceBranch,
        production_branch: productionBranch,
        status: 'active',
        source_sha: null,
        production_sha: null,
        last_successful_sync_at: null,
        configuration_version: 1,
        required_check_policy_version: 0,
        required_check_overrides: JSON.stringify(
          normalizeRequiredCheckOverrides(input.requiredCheckOverrides ?? []),
        ),
        deletion_requested_at: null,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return mapProject(row)
  })
}

export async function getProject(
  database: DatabaseClient,
  projectId: string,
): Promise<ProjectRecord | undefined> {
  assertLocalId(projectId, 'project ID')

  const row = await database.kysely
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', projectId)
    .executeTakeFirst()

  return row ? mapProject(row) : undefined
}

export async function archiveRepositoryProjectionInTransaction(
  scope: RepositoryTransaction,
  input: {
    readonly reconciliationRequestId: string
    readonly syncRunId: string
    readonly projectId: string
    readonly repositoryId: string
    readonly archivedAt: Date
  },
): Promise<string> {
  const repositoryId = assertRepositoryTransaction(scope, input.repositoryId)
  const transaction = scope.transaction
  const existing = await transaction
    .selectFrom('repository_projection_archives')
    .select('id')
    .where('reconciliation_request_id', '=', input.reconciliationRequestId)
    .executeTakeFirst()

  if (existing) {
    return existing.id
  }

  const project = await transaction
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', input.projectId)
    .where('repository_id', '=', repositoryId)
    .forUpdate()
    .executeTakeFirstOrThrow()
  const branches = await transaction
    .selectFrom('repository_branches')
    .selectAll()
    .where('project_id', '=', input.projectId)
    .orderBy('name')
    .execute()
  const commits = await transaction
    .selectFrom('repository_commits')
    .selectAll()
    .where('project_id', '=', input.projectId)
    .orderBy('source_delta_position')
    .orderBy('committed_at')
    .orderBy('sha')
    .execute()
  const changes = await transaction
    .selectFrom('changes')
    .selectAll()
    .where('project_id', '=', input.projectId)
    .orderBy('merged_at')
    .orderBy('pull_request_number')
    .execute()
  const changeCommits = await transaction
    .selectFrom('change_commits')
    .selectAll()
    .where('project_id', '=', input.projectId)
    .orderBy('change_id')
    .orderBy('position')
    .execute()
  const requiredChecks =
    project.required_check_policy_version === 0
      ? []
      : await transaction
          .selectFrom('required_checks')
          .selectAll()
          .where('project_id', '=', input.projectId)
          .where('policy_version', '=', project.required_check_policy_version)
          .orderBy('context')
          .orderBy('integration_id')
          .execute()
  const checkResults = await transaction
    .selectFrom('commit_check_results')
    .selectAll()
    .where('project_id', '=', input.projectId)
    .orderBy('commit_sha')
    .orderBy('check_type')
    .orderBy('context')
    .orderBy('github_object_id')
    .execute()
  const requiredCheckStates = await transaction
    .selectFrom('change_required_check_states')
    .selectAll()
    .where('project_id', '=', input.projectId)
    .orderBy('change_id')
    .orderBy('required_check_id')
    .execute()
  const previousRun = await transaction
    .selectFrom('repository_sync_runs')
    .selectAll()
    .where('project_id', '=', input.projectId)
    .where('status', '=', 'succeeded')
    .where('id', '<>', input.syncRunId)
    .orderBy('completed_at', 'desc')
    .executeTakeFirst()
  const issues = previousRun
    ? await transaction
        .selectFrom('repository_sync_issues')
        .selectAll()
        .where('sync_run_id', '=', previousRun.id)
        .orderBy('created_at')
        .execute()
    : []
  const archiveId = randomUUID()
  const snapshot = toJsonValue({
    schemaVersion: 1,
    project,
    branches,
    commits,
    changes,
    changeCommits,
    requiredChecks,
    checkResults,
    requiredCheckStates,
    previousRun: previousRun ?? null,
    issues,
  })
  const inserted = await transaction
    .insertInto('repository_projection_archives')
    .values({
      id: archiveId,
      reconciliation_request_id: input.reconciliationRequestId,
      sync_run_id: input.syncRunId,
      project_id: input.projectId,
      repository_id: repositoryId,
      source_sha: project.source_sha,
      production_sha: project.production_sha,
      classification: 'destructive_history_change',
      snapshot: JSON.stringify(snapshot),
      archived_at: input.archivedAt,
    })
    .onConflict((conflict) => conflict.column('reconciliation_request_id').doNothing())
    .returning('id')
    .executeTakeFirst()

  if (inserted) {
    const resetProject = await transaction
      .updateTable('projects')
      .set({
        qa_reset_epoch: sql<number>`qa_reset_epoch + 1`,
        release_state_version: sql<number>`release_state_version + 1`,
        updated_at: input.archivedAt,
      })
      .where('id', '=', input.projectId)
      .where('repository_id', '=', repositoryId)
      .returning([
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
      ])
      .executeTakeFirstOrThrow()

    await queueActiveCandidateEvaluationInTransaction(transaction, {
      project: resetProject,
      reason: 'project_degraded',
      now: input.archivedAt,
    })

    return inserted.id
  }

  const archive = await transaction
    .selectFrom('repository_projection_archives')
    .select('id')
    .where('reconciliation_request_id', '=', input.reconciliationRequestId)
    .executeTakeFirstOrThrow()

  return archive.id
}

export async function applyRepositoryProjection(
  database: DatabaseClient,
  input: ApplyRepositoryProjectionInput,
): Promise<ApplyRepositoryProjectionResult> {
  const repositoryId = serializeGitHubNumericId(input.repositoryId, 'repository ID')

  return withRepositoryTransaction(database, repositoryId, (scope) =>
    applyRepositoryProjectionInTransaction(scope, input),
  )
}

export async function applyRepositoryProjectionInTransaction(
  scope: RepositoryTransaction,
  input: ApplyRepositoryProjectionInput,
): Promise<ApplyRepositoryProjectionResult> {
  validateApplyInput(input)
  const repositoryId = assertRepositoryTransaction(scope, input.repositoryId)
  const transaction = scope.transaction
  const project = await requireProjectForWrite(
    transaction,
    input.projectId,
    repositoryId,
    input.expectedConfigurationVersion,
  )

  validateSnapshotAgainstProject(input.snapshot, project)

  const existingRun = await transaction
    .selectFrom('repository_sync_runs')
    .select([
      'id',
      'status',
      'configuration_version',
      'projection_fingerprint',
      'source_sha',
      'production_sha',
    ])
    .where('project_id', '=', input.projectId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst()

  if (existingRun?.status === 'succeeded') {
    const sameProjection =
      existingRun.projection_fingerprint === input.projectionFingerprint &&
      existingRun.source_sha === input.snapshot.sourceSha &&
      existingRun.production_sha === input.snapshot.productionSha

    if (!sameProjection) {
      throw new RepositoryProjectionIdempotencyConflictError(input.projectId, input.idempotencyKey)
    }

    const currentProject = await transaction
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', input.projectId)
      .executeTakeFirstOrThrow()

    return {
      status: 'already_applied',
      syncRunId: existingRun.id,
      project: mapProject(currentProject),
    }
  }

  if (existingRun && ['failed', 'superseded'].includes(existingRun.status)) {
    throw new RepositoryProjectionIdempotencyConflictError(input.projectId, input.idempotencyKey)
  }

  const previousSuccessfulRun = await transaction
    .selectFrom('repository_sync_runs')
    .select(['projection_fingerprint', 'source_sha', 'production_sha'])
    .where('project_id', '=', input.projectId)
    .where('status', '=', 'succeeded')
    .orderBy('completed_at', 'desc')
    .orderBy('created_at', 'desc')
    .executeTakeFirst()

  const storedChanges = await prepareStoredChanges(
    transaction,
    input.projectId,
    input.snapshot.changes,
  )
  const syncRunId = existingRun?.id ?? input.syncRunId ?? randomUUID()
  const observedAt = input.snapshot.observedAt
  const reconciliationClassification = input.reconciliationClassification ?? 'expected_change'
  const differenceSummary = input.differenceSummary ?? {}

  if (existingRun) {
    const samePendingRun =
      input.syncRunId === existingRun.id &&
      existingRun.configuration_version === input.expectedConfigurationVersion &&
      existingRun.source_sha === input.snapshot.sourceSha &&
      existingRun.production_sha === input.snapshot.productionSha

    if (!samePendingRun) {
      throw new RepositoryProjectionIdempotencyConflictError(input.projectId, input.idempotencyKey)
    }

    await transaction
      .updateTable('repository_sync_runs')
      .set({
        status: 'succeeded',
        projection_fingerprint: input.projectionFingerprint,
        source_sha: input.snapshot.sourceSha,
        production_sha: input.snapshot.productionSha,
        completed_at: input.completedAt,
        error_code: null,
        error_message: null,
        reconciliation_classification: reconciliationClassification,
        difference_summary: JSON.stringify(differenceSummary),
      })
      .where('id', '=', existingRun.id)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirstOrThrow()
  } else {
    await transaction
      .insertInto('repository_sync_runs')
      .values({
        id: syncRunId,
        project_id: input.projectId,
        repository_id: repositoryId,
        reason: input.reason,
        status: 'succeeded',
        configuration_version: input.expectedConfigurationVersion,
        idempotency_key: input.idempotencyKey,
        projection_fingerprint: input.projectionFingerprint,
        source_sha: input.snapshot.sourceSha,
        production_sha: input.snapshot.productionSha,
        started_at: input.startedAt,
        completed_at: input.completedAt,
        error_code: null,
        error_message: null,
        reconciliation_classification: reconciliationClassification,
        difference_summary: JSON.stringify(differenceSummary),
      })
      .execute()
  }

  await clearCurrentProjection(transaction, input.projectId)

  if (input.snapshot.branches.length > 0) {
    await transaction
      .insertInto('repository_branches')
      .values(
        input.snapshot.branches.map((branch) => ({
          project_id: input.projectId,
          repository_id: repositoryId,
          name: branch.name,
          head_sha: branch.headSha,
          protected: branch.protected,
          default_branch: branch.defaultBranch,
          observed_at: observedAt,
          updated_at: observedAt,
        })),
      )
      .execute()
  }

  if (input.snapshot.commits.length > 0) {
    await transaction
      .insertInto('repository_commits')
      .values(
        input.snapshot.commits.map((commit) => ({
          project_id: input.projectId,
          repository_id: repositoryId,
          sha: commit.sha,
          tree_sha: commit.treeSha,
          message: commit.message,
          author_id: serializeNullableGitHubNumericId(commit.authorId, 'commit author ID'),
          author_login: commit.authorLogin,
          author_name: commit.authorName,
          author_email: commit.authorEmail,
          committer_id: serializeNullableGitHubNumericId(commit.committerId, 'commit committer ID'),
          committer_login: commit.committerLogin,
          authored_at: commit.authoredAt,
          committed_at: commit.committedAt,
          parent_shas: JSON.stringify(commit.parentShas),
          source_delta_position: commit.sourceDeltaPosition,
          first_parent_position: commit.firstParentPosition,
          integration_point_sha: commit.integrationPointSha,
          production_patch_equivalent: commit.productionPatchEquivalent,
          attribution_state: commit.attributionState,
          observed_at: observedAt,
          updated_at: observedAt,
        })),
      )
      .execute()
  }

  await reconcileMissingChanges(
    transaction,
    input.projectId,
    storedChanges.map((change) => change.githubPullRequestId),
    input.preserveMissingChangesAsUnknown === true,
    observedAt,
  )

  for (const stored of storedChanges) {
    const values = {
      pull_request_number: stored.input.pullRequestNumber,
      title: stored.input.title,
      url: stored.input.url,
      author_id: stored.authorId,
      author_login: stored.input.authorLogin,
      base_branch: stored.input.baseBranch,
      merged_at: stored.input.mergedAt,
      final_head_sha: stored.input.finalHeadSha,
      merge_commit_sha: stored.input.mergeCommitSha,
      source_integration_sha: stored.input.sourceIntegrationSha,
      integration_first_parent_sha: stored.input.integrationFirstParentSha,
      integration_second_parent_sha: stored.input.integrationSecondParentSha,
      merge_method: stored.input.mergeMethod,
      commit_set_fingerprint: stored.input.commitSetFingerprint,
      synchronization_state: stored.input.synchronizationState,
      production_presence: stored.input.productionPresence,
      observed_at: observedAt,
      updated_at: observedAt,
    }

    if (stored.existing) {
      await transaction
        .updateTable('changes')
        .set(values)
        .where('id', '=', stored.id)
        .where('github_pull_request_id', '=', stored.githubPullRequestId)
        .executeTakeFirstOrThrow()
    } else {
      await transaction
        .insertInto('changes')
        .values({
          id: stored.id,
          project_id: input.projectId,
          repository_id: repositoryId,
          github_pull_request_id: stored.githubPullRequestId,
          ...values,
        })
        .execute()
    }
  }

  const changeCommitRows = storedChanges.flatMap((stored) =>
    stored.input.commitShas.map((commitSha, position) => ({
      project_id: input.projectId,
      repository_id: repositoryId,
      change_id: stored.id,
      commit_sha: commitSha,
      position,
    })),
  )

  if (changeCommitRows.length > 0) {
    await transaction.insertInto('change_commits').values(changeCommitRows).execute()
  }

  const requiredCheckTargetShas = [
    ...new Set(
      input.snapshot.changes
        .filter((change) => change.productionPresence !== 'released')
        .map((change) => change.finalHeadSha),
    ),
  ]

  await applyRequiredCheckProjectionInTransaction(scope, {
    projectId: input.projectId,
    repositoryId,
    expectedConfigurationVersion: input.expectedConfigurationVersion,
    requiredChecks: input.snapshot.requiredChecks,
    checkResults: input.snapshot.checkResults,
    targetCommitShas: requiredCheckTargetShas,
    recomputeAllChanges: true,
    observedAt,
    trigger: {
      reason: input.reason,
      auditSource: 'reconciliation',
      actorGitHubUserId: null,
    },
    suppressCandidateReevaluation: true,
  })

  await insertSynchronizationIssues(
    transaction,
    input.projectId,
    repositoryId,
    syncRunId,
    input.snapshot.issues,
  )

  const destructiveQaResetAlreadyApplied =
    reconciliationClassification === 'destructive_history_change' &&
    (await transaction
      .selectFrom('repository_projection_archives')
      .select('id')
      .where('sync_run_id', '=', syncRunId)
      .where('project_id', '=', input.projectId)
      .where('repository_id', '=', repositoryId)
      .executeTakeFirst()) !== undefined
  const shouldResetQaForDestructiveHistory =
    reconciliationClassification === 'destructive_history_change' &&
    !destructiveQaResetAlreadyApplied
  const nextProjectStatus = ['destructive_history_change', 'unknown_inconsistency'].includes(
    reconciliationClassification,
  )
    ? ('degraded' as const)
    : ('active' as const)
  const projectionChanged =
    project.last_successful_sync_at === null ||
    previousSuccessfulRun === undefined ||
    previousSuccessfulRun.projection_fingerprint !== input.projectionFingerprint ||
    previousSuccessfulRun.source_sha !== input.snapshot.sourceSha ||
    previousSuccessfulRun.production_sha !== input.snapshot.productionSha
  const releaseStateChanged =
    projectionChanged ||
    project.status !== nextProjectStatus ||
    shouldResetQaForDestructiveHistory ||
    reconciliationClassification === 'recoverable_drift'
  const updated = await transaction
    .updateTable('projects')
    .set({
      installation_id: serializeGitHubNumericId(input.snapshot.installationId, 'installation ID'),
      owner_id: serializeGitHubNumericId(input.snapshot.ownerId, 'repository owner ID'),
      owner_login: input.snapshot.ownerLogin,
      repository_name: input.snapshot.repositoryName,
      repository_full_name: input.snapshot.repositoryFullName,
      default_branch: input.snapshot.defaultBranch,
      status: nextProjectStatus,
      source_sha: input.snapshot.sourceSha,
      production_sha: input.snapshot.productionSha,
      merge_base_sha: input.snapshot.mergeBaseSha,
      last_successful_sync_at: input.completedAt,
      ...(shouldResetQaForDestructiveHistory
        ? { qa_reset_epoch: sql<number>`qa_reset_epoch + 1` }
        : {}),
      ...(releaseStateChanged
        ? { release_state_version: sql<number>`release_state_version + 1` }
        : {}),
      ...(projectionChanged ? { projection_version: sql<number>`projection_version + 1` } : {}),
      deletion_requested_at: null,
      deleted_at: null,
      updated_at: input.completedAt,
    })
    .where('id', '=', input.projectId)
    .where('configuration_version', '=', input.expectedConfigurationVersion)
    .returningAll()
    .executeTakeFirst()

  if (!updated) {
    throw new ProjectVersionConflictError(
      input.projectId,
      input.expectedConfigurationVersion,
      project.configuration_version,
    )
  }

  if (releaseStateChanged) {
    const evaluationReason =
      project.last_successful_sync_at === null
        ? 'first_projection'
        : nextProjectStatus !== 'active'
          ? 'project_degraded'
          : project.status !== 'active'
            ? 'reconciliation_corrected'
            : project.production_sha !== input.snapshot.productionSha
              ? 'production_changed'
              : project.source_sha !== input.snapshot.sourceSha
                ? 'source_topology_changed'
                : 'reconciliation_corrected'

    await queueActiveCandidateEvaluationInTransaction(transaction, {
      project: updated,
      reason: evaluationReason,
      now: input.completedAt,
    })
  }

  return {
    status: 'applied',
    syncRunId,
    project: mapProject(updated),
  }
}

export async function recordRepositorySyncFailure(
  database: DatabaseClient,
  input: RecordRepositorySyncFailureInput,
): Promise<RecordRepositorySyncFailureResult> {
  validateFailureInput(input)
  const repositoryId = serializeGitHubNumericId(input.repositoryId, 'repository ID')

  return withRepositoryTransaction(database, repositoryId, async ({ transaction }) => {
    await requireProjectForWrite(
      transaction,
      input.projectId,
      repositoryId,
      input.expectedConfigurationVersion,
    )

    const existingRun = await transaction
      .selectFrom('repository_sync_runs')
      .select(['id', 'status', 'error_code'])
      .where('project_id', '=', input.projectId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst()

    if (existingRun) {
      if (existingRun.status !== 'failed' || existingRun.error_code !== input.errorCode) {
        throw new RepositoryProjectionIdempotencyConflictError(
          input.projectId,
          input.idempotencyKey,
        )
      }

      return {
        status: 'already_recorded',
        syncRunId: existingRun.id,
      }
    }

    const syncRunId = randomUUID()
    const reconciliationClassification =
      input.reconciliationClassification ??
      (input.disconnectProject === true ? 'permission_problem' : 'unknown_inconsistency')

    await transaction
      .insertInto('repository_sync_runs')
      .values({
        id: syncRunId,
        project_id: input.projectId,
        repository_id: repositoryId,
        reason: input.reason,
        status: 'failed',
        configuration_version: input.expectedConfigurationVersion,
        idempotency_key: input.idempotencyKey,
        projection_fingerprint: null,
        source_sha: input.sourceSha ?? null,
        production_sha: input.productionSha ?? null,
        started_at: input.startedAt,
        completed_at: input.completedAt,
        error_code: input.errorCode,
        error_message: input.errorMessage ?? null,
        reconciliation_classification: reconciliationClassification,
        difference_summary: JSON.stringify(input.differenceSummary ?? {}),
      })
      .execute()

    await insertSynchronizationIssues(
      transaction,
      input.projectId,
      repositoryId,
      syncRunId,
      input.issues,
    )

    if (
      input.disconnectProject === true ||
      reconciliationClassification === 'destructive_history_change'
    ) {
      const degradedProject = await transaction
        .updateTable('projects')
        .set({
          status: input.disconnectProject === true ? 'disconnected' : 'degraded',
          ...(reconciliationClassification === 'destructive_history_change'
            ? { qa_reset_epoch: sql<number>`qa_reset_epoch + 1` }
            : {}),
          release_state_version: sql<number>`release_state_version + 1`,
          updated_at: input.completedAt,
        })
        .where('id', '=', input.projectId)
        .where('status', 'in', ['initializing', 'active', 'degraded', 'disconnected'])
        .returning([
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
        ])
        .executeTakeFirst()

      if (degradedProject) {
        await queueActiveCandidateEvaluationInTransaction(transaction, {
          project: degradedProject,
          reason: 'project_degraded',
          now: input.completedAt,
        })
      }
    }

    return {
      status: 'recorded',
      syncRunId,
    }
  })
}

export async function listChangesAheadOfProduction(
  database: DatabaseClient,
  projectId: string,
): Promise<readonly ChangeAheadOfProduction[]> {
  assertLocalId(projectId, 'project ID')

  return database.kysely
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute((transaction) => listChangesAheadOfProductionSnapshot(transaction, projectId))
}

async function listChangesAheadOfProductionSnapshot(
  database: Kysely<DatabaseSchema>,
  projectId: string,
): Promise<readonly ChangeAheadOfProduction[]> {
  const project = await database
    .selectFrom('projects')
    .select('required_check_policy_version')
    .where('id', '=', projectId)
    .executeTakeFirst()

  if (!project) {
    throw new ProjectNotFoundError(projectId)
  }

  const configuredCheckCount =
    project.required_check_policy_version === 0
      ? 0
      : Number(
          (
            await database
              .selectFrom('required_checks')
              .select(({ fn }) => fn.countAll().as('count'))
              .where('project_id', '=', projectId)
              .where('policy_version', '=', project.required_check_policy_version)
              .executeTakeFirstOrThrow()
          ).count,
        )

  const rows = await database
    .selectFrom('changes')
    .select([
      'id',
      'github_pull_request_id',
      'pull_request_number',
      'title',
      'url',
      'author_id',
      'author_login',
      'merged_at',
      'merge_method',
      'commit_set_fingerprint',
      'synchronization_state',
      'production_presence',
      'final_head_sha',
    ])
    .where('project_id', '=', projectId)
    .where((expression) =>
      expression.or([
        expression('synchronization_state', '=', 'unknown'),
        expression.and([
          expression('synchronization_state', '=', 'known'),
          expression('production_presence', 'in', ['unreleased', 'partially_present']),
        ]),
      ]),
    )
    .orderBy('merged_at')
    .orderBy('pull_request_number')
    .execute()

  if (rows.length === 0) {
    return []
  }

  const commitRows = await database
    .selectFrom('change_commits')
    .select(['change_id', 'commit_sha', 'position'])
    .where(
      'change_id',
      'in',
      rows.map((row) => row.id),
    )
    .orderBy('change_id')
    .orderBy('position')
    .execute()
  const commitsByChange = new Map<string, string[]>()

  for (const commit of commitRows) {
    const commits = commitsByChange.get(commit.change_id) ?? []
    commits.push(commit.commit_sha)
    commitsByChange.set(commit.change_id, commits)
  }

  const changeIds = rows.map((row) => row.id)
  const [requiredChecksByChange, qaRows] = await Promise.all([
    loadRequiredCheckStatesForChanges(database, changeIds),
    database
      .selectFrom('effective_change_qa_assessments')
      .select(['id', 'change_id', 'status', 'comment', 'actor_github_user_id', 'created_at'])
      .where('project_id', '=', projectId)
      .where('change_id', 'in', changeIds)
      .execute(),
  ])
  const qaByChange = new Map<string, ChangeQaState>(
    qaRows.map(
      (qa) =>
        [
          qa.change_id,
          {
            status: qa.status,
            assessmentId: qa.id,
            comment: qa.comment,
            actorGitHubUserId: qa.actor_github_user_id,
            assessedAt: qa.created_at,
          },
        ] as const,
    ),
  )

  return rows.map((row) => {
    const requiredChecks = requiredChecksByChange.get(row.id) ?? []

    if (row.synchronization_state === 'known' && !row.commit_set_fingerprint) {
      throw new Error(`Known change ${row.id} has no commit set fingerprint`)
    }

    return {
      id: row.id,
      githubPullRequestId: row.github_pull_request_id,
      pullRequestNumber: row.pull_request_number,
      title: row.title,
      url: row.url,
      authorId: row.author_id,
      authorLogin: row.author_login,
      mergedAt: row.merged_at,
      mergeMethod: row.merge_method,
      commitSetFingerprint: row.commit_set_fingerprint,
      synchronizationState: row.synchronization_state,
      productionPresence: assertDashboardProductionPresence(row.production_presence),
      checkState: summarizeProjectCheckState({
        configuredCheckCount,
        hasKnownChangesAhead: row.synchronization_state === 'known',
        expectedStateCount: configuredCheckCount,
        synchronizationState: row.synchronization_state,
        states: requiredChecks.map((required) => required.state),
      }),
      qa: qaByChange.get(row.id) ?? {
        status: 'pending',
        assessmentId: null,
        comment: null,
        actorGitHubUserId: null,
        assessedAt: null,
      },
      finalHeadSha: row.final_head_sha,
      commitShas: commitsByChange.get(row.id) ?? [],
      requiredChecks,
    }
  })
}

export async function listUnmanagedCommits(
  database: DatabaseClient,
  projectId: string,
): Promise<readonly UnmanagedCommitRecord[]> {
  assertLocalId(projectId, 'project ID')

  const rows = await database.kysely
    .selectFrom('repository_commits as commit')
    .leftJoin('change_commits as membership', (join) =>
      join
        .onRef('membership.repository_id', '=', 'commit.repository_id')
        .onRef('membership.commit_sha', '=', 'commit.sha'),
    )
    .select([
      'commit.sha',
      'commit.message',
      'commit.author_id',
      'commit.author_login',
      'commit.committed_at',
      'commit.source_delta_position',
    ])
    .where('commit.project_id', '=', projectId)
    .where('commit.source_delta_position', 'is not', null)
    .where('commit.attribution_state', '=', 'unmanaged')
    .where('membership.change_id', 'is', null)
    .orderBy('commit.source_delta_position')
    .execute()

  return rows.map((row) => {
    if (row.source_delta_position === null) {
      throw new Error(`Unmanaged commit ${row.sha} has no source delta position`)
    }

    return {
      sha: row.sha,
      message: row.message,
      authorId: row.author_id,
      authorLogin: row.author_login,
      committedAt: row.committed_at,
      sourceDeltaPosition: row.source_delta_position,
    }
  })
}

type ProjectRow = Selectable<ProjectTable>
type ProjectWriteTransaction = Transaction<DatabaseSchema>

async function requireProjectForWrite(
  transaction: ProjectWriteTransaction,
  projectId: string,
  repositoryId: string,
  expectedConfigurationVersion: number,
): Promise<ProjectRow> {
  assertLocalId(projectId, 'project ID')
  assertPositiveInteger(expectedConfigurationVersion, 'expected configuration version')

  const project = await transaction
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', projectId)
    .forUpdate()
    .executeTakeFirst()

  if (!project || project.status === 'deleted') {
    throw new ProjectNotFoundError(projectId)
  }

  if (project.repository_id !== repositoryId) {
    throw new RepositoryProjectionInvariantError(
      `Project ${projectId} belongs to repository ${project.repository_id}, not ${repositoryId}`,
    )
  }

  if (project.configuration_version !== expectedConfigurationVersion) {
    throw new ProjectVersionConflictError(
      projectId,
      expectedConfigurationVersion,
      project.configuration_version,
    )
  }

  if (project.status === 'pending_deletion') {
    throw new RepositoryProjectionInvariantError(
      `Project ${projectId} is pending deletion and cannot accept a repository projection`,
    )
  }

  return project
}

interface StoredChange {
  readonly input: ChangeProjection
  readonly id: string
  readonly githubPullRequestId: string
  readonly authorId: string | null
  readonly existing: boolean
}

async function prepareStoredChanges(
  transaction: ProjectWriteTransaction,
  projectId: string,
  changes: readonly ChangeProjection[],
): Promise<readonly StoredChange[]> {
  const existingRows: readonly {
    readonly id: string
    readonly github_pull_request_id: string
    readonly pull_request_number: number
    readonly author_id: string | null
  }[] = await transaction
    .selectFrom('changes')
    .select(['id', 'github_pull_request_id', 'pull_request_number', 'author_id'])
    .where('project_id', '=', projectId)
    .execute()
  const existingByGitHubId = new Map(
    existingRows.map((row) => [row.github_pull_request_id, row] as const),
  )
  const existingByNumber = new Map(
    existingRows.map((row) => [row.pull_request_number, row] as const),
  )
  const existingByLocalId = new Map(existingRows.map((row) => [row.id, row] as const))

  return changes.map((change): StoredChange => {
    const githubPullRequestId = serializeGitHubNumericId(
      change.githubPullRequestId,
      'GitHub pull request ID',
    )
    const existingById = existingByGitHubId.get(githubPullRequestId)
    const existingByPullNumber = existingByNumber.get(change.pullRequestNumber)

    if (
      existingByPullNumber &&
      existingByPullNumber.github_pull_request_id !== githubPullRequestId
    ) {
      throw new RepositoryProjectionInvariantError(
        [
          `Pull request #${change.pullRequestNumber} changed immutable GitHub identity`,
          `from ${existingByPullNumber.github_pull_request_id} to ${githubPullRequestId}`,
        ].join(' '),
      )
    }

    if (existingById && existingById.pull_request_number !== change.pullRequestNumber) {
      throw new RepositoryProjectionInvariantError(
        [
          `GitHub pull request ${githubPullRequestId} changed immutable number`,
          `from ${existingById.pull_request_number} to ${change.pullRequestNumber}`,
        ].join(' '),
      )
    }

    const observedAuthorId = serializeNullableGitHubNumericId(change.authorId, 'change author ID')

    if (
      existingById?.author_id !== null &&
      existingById?.author_id !== undefined &&
      observedAuthorId !== null &&
      existingById.author_id !== observedAuthorId
    ) {
      throw new RepositoryProjectionInvariantError(
        `GitHub pull request ${githubPullRequestId} changed immutable author identity`,
      )
    }

    if (change.id !== undefined) {
      assertLocalId(change.id, 'change ID')
      const existingLocalId = existingByLocalId.get(change.id)

      if (existingLocalId && existingLocalId.github_pull_request_id !== githubPullRequestId) {
        throw new RepositoryProjectionInvariantError(
          [
            `Change ID ${change.id} already belongs to GitHub pull request`,
            existingLocalId.github_pull_request_id,
          ].join(' '),
        )
      }

      if (existingById && existingById.id !== change.id) {
        throw new RepositoryProjectionInvariantError(
          `GitHub pull request ${githubPullRequestId} already belongs to Change ${existingById.id}`,
        )
      }
    }

    return {
      input: change,
      id: existingById?.id ?? change.id ?? randomUUID(),
      githubPullRequestId,
      authorId: existingById?.author_id ?? observedAuthorId,
      existing: existingById !== undefined,
    }
  })
}

async function reconcileMissingChanges(
  transaction: ProjectWriteTransaction,
  projectId: string,
  githubPullRequestIds: readonly string[],
  preserveAsUnknown: boolean,
  observedAt: Date,
): Promise<void> {
  if (preserveAsUnknown) {
    let query = transaction
      .updateTable('changes')
      .set({
        synchronization_state: 'unknown',
        production_presence: 'unknown',
        observed_at: observedAt,
        updated_at: observedAt,
      })
      .where('project_id', '=', projectId)

    if (githubPullRequestIds.length > 0) {
      query = query.where('github_pull_request_id', 'not in', githubPullRequestIds)
    }

    await query.execute()
    return
  }

  let query = transaction
    .deleteFrom('changes')
    .where('project_id', '=', projectId)
    .where('synchronization_state', '<>', 'unknown')

  if (githubPullRequestIds.length > 0) {
    query = query.where('github_pull_request_id', 'not in', githubPullRequestIds)
  }

  await query.execute()
}

async function clearCurrentProjection(
  transaction: ProjectWriteTransaction,
  projectId: string,
): Promise<void> {
  await transaction.deleteFrom('change_commits').where('project_id', '=', projectId).execute()
  await transaction.deleteFrom('repository_commits').where('project_id', '=', projectId).execute()
  await transaction.deleteFrom('repository_branches').where('project_id', '=', projectId).execute()
}

async function insertSynchronizationIssues(
  transaction: ProjectWriteTransaction,
  projectId: string,
  repositoryId: string,
  syncRunId: string,
  issues: readonly RepositorySyncIssueProjection[],
): Promise<void> {
  if (issues.length === 0) {
    return
  }

  await transaction
    .insertInto('repository_sync_issues')
    .values(
      issues.map((issue) => ({
        id: issue.id ?? randomUUID(),
        sync_run_id: syncRunId,
        project_id: projectId,
        repository_id: repositoryId,
        severity: issue.severity,
        code: issue.code,
        scope: issue.scope,
        subject_id: issue.subjectId,
        message: issue.message,
        details: JSON.stringify(issue.details ?? {}),
      })),
    )
    .execute()
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function validateApplyInput(input: ApplyRepositoryProjectionInput): void {
  assertLocalId(input.projectId, 'project ID')
  assertPositiveInteger(input.expectedConfigurationVersion, 'expected configuration version')
  assertNonEmpty(input.reason, 'synchronization reason')
  assertNonEmpty(input.idempotencyKey, 'synchronization idempotency key')
  assertFingerprint(input.projectionFingerprint, 'projection fingerprint')
  assertValidDate(input.startedAt, 'synchronization start time')
  assertValidDate(input.completedAt, 'synchronization completion time')

  if (input.completedAt.getTime() < input.startedAt.getTime()) {
    throw new RepositoryProjectionInvariantError(
      'Synchronization completion time cannot precede its start time',
    )
  }

  validateRepositoryProjectionSnapshot(input.snapshot)
}

function validateFailureInput(input: RecordRepositorySyncFailureInput): void {
  assertLocalId(input.projectId, 'project ID')
  assertPositiveInteger(input.expectedConfigurationVersion, 'expected configuration version')
  assertNonEmpty(input.reason, 'synchronization reason')
  assertNonEmpty(input.idempotencyKey, 'synchronization idempotency key')
  assertNonEmpty(input.errorCode, 'synchronization error code')
  assertValidDate(input.startedAt, 'synchronization start time')
  assertValidDate(input.completedAt, 'synchronization completion time')

  if (input.completedAt.getTime() < input.startedAt.getTime()) {
    throw new RepositoryProjectionInvariantError(
      'Synchronization completion time cannot precede its start time',
    )
  }

  if ((input.sourceSha === undefined) !== (input.productionSha === undefined)) {
    throw new RepositoryProjectionInvariantError(
      'Failed synchronization must provide both source and production SHA or neither',
    )
  }

  if (input.sourceSha !== undefined) {
    assertCommitSha(input.sourceSha, 'source SHA')
    assertCommitSha(input.productionSha as string, 'production SHA')
  }

  validateIssues(input.issues)
}

export function validateRepositoryProjectionSnapshot(snapshot: RepositoryProjectionSnapshot): void {
  serializeGitHubNumericId(snapshot.installationId, 'installation ID')
  serializeGitHubNumericId(snapshot.ownerId, 'repository owner ID')
  assertNonEmpty(snapshot.ownerLogin, 'repository owner login')
  assertNonEmpty(snapshot.repositoryName, 'repository name')
  assertNonEmpty(snapshot.repositoryFullName, 'repository full name')
  assertCommitSha(snapshot.sourceSha, 'source SHA')
  assertCommitSha(snapshot.productionSha, 'production SHA')
  assertCommitSha(snapshot.mergeBaseSha, 'merge base SHA')
  assertValidDate(snapshot.observedAt, 'projection observation time')

  if (snapshot.mergeBaseSha !== snapshot.productionSha) {
    throw new RepositoryProjectionInvariantError(
      `Merge base ${snapshot.mergeBaseSha} must equal production SHA ${snapshot.productionSha}`,
    )
  }

  if (snapshot.defaultBranch !== null) {
    assertBranchName(snapshot.defaultBranch, 'default branch')
  }

  const branches = new Set<string>()

  for (const branch of snapshot.branches) {
    const name = assertBranchName(branch.name, 'repository branch')
    assertUnique(branches, name, `Duplicate repository branch ${name}`)
    assertCommitSha(branch.headSha, `head SHA for branch ${name}`)
  }

  const commits = new Map<string, RepositoryProjectionSnapshot['commits'][number]>()
  const sourcePositions = new Set<number>()
  const firstParentPositions = new Set<number>()

  for (const commit of snapshot.commits) {
    assertCommitSha(commit.sha, 'repository commit SHA')

    if (commits.has(commit.sha)) {
      throw new RepositoryProjectionInvariantError(`Duplicate repository commit ${commit.sha}`)
    }

    commits.set(commit.sha, commit)

    if (commit.treeSha !== null) {
      assertCommitSha(commit.treeSha, `tree SHA for commit ${commit.sha}`)
    }

    serializeNullableGitHubNumericId(commit.authorId, 'commit author ID')
    serializeNullableGitHubNumericId(commit.committerId, 'commit committer ID')
    assertValidDate(commit.committedAt, `committed time for ${commit.sha}`)

    if (commit.authoredAt !== null) {
      assertValidDate(commit.authoredAt, `authored time for ${commit.sha}`)
    }

    for (const parentSha of commit.parentShas) {
      assertCommitSha(parentSha, `parent SHA for commit ${commit.sha}`)
    }

    if (typeof commit.productionPatchEquivalent !== 'boolean') {
      throw new RepositoryProjectionInvariantError(
        `Commit ${commit.sha} has an invalid production patch-equivalence flag`,
      )
    }

    if (!['managed', 'unmanaged', 'ambiguous'].includes(commit.attributionState)) {
      throw new RepositoryProjectionInvariantError(
        `Commit ${commit.sha} has an invalid attribution state`,
      )
    }

    if (commit.integrationPointSha !== null) {
      assertCommitSha(commit.integrationPointSha, `integration point for commit ${commit.sha}`)
    }

    if (commit.firstParentPosition !== null) {
      assertNonNegativeInteger(
        commit.firstParentPosition,
        `first-parent position for commit ${commit.sha}`,
      )
      assertUnique(
        firstParentPositions,
        commit.firstParentPosition,
        `Duplicate first-parent position ${commit.firstParentPosition}`,
      )
    }

    if (commit.sourceDeltaPosition !== null) {
      assertNonNegativeInteger(
        commit.sourceDeltaPosition,
        `source delta position for commit ${commit.sha}`,
      )
      assertUnique(
        sourcePositions,
        commit.sourceDeltaPosition,
        `Duplicate source delta position ${commit.sourceDeltaPosition}`,
      )

      if (commit.integrationPointSha === null) {
        throw new RepositoryProjectionInvariantError(
          `Source commit ${commit.sha} has no first-parent integration point`,
        )
      }
    }
  }

  assertContiguousPositions(sourcePositions, 'Source delta')
  assertContiguousPositions(firstParentPositions, 'First-parent history')

  for (const commit of commits.values()) {
    if (commit.integrationPointSha === null) {
      continue
    }

    const integration = commits.get(commit.integrationPointSha)

    if (integration === undefined) {
      throw new RepositoryProjectionInvariantError(
        `Commit ${commit.sha} references invalid integration point ${commit.integrationPointSha}`,
      )
    }

    if (integration.firstParentPosition === null) {
      throw new RepositoryProjectionInvariantError(
        `Commit ${commit.sha} references invalid integration point ${commit.integrationPointSha}`,
      )
    }
  }

  const orderedSourcePositions = [...sourcePositions].sort((left, right) => left - right)
  const orderedFirstParentPositions = [...firstParentPositions].sort((left, right) => left - right)

  if (snapshot.sourceSha !== snapshot.productionSha) {
    const sourceHead = commits.get(snapshot.sourceSha)

    if (sourceHead === undefined) {
      throw new RepositoryProjectionInvariantError(
        `Source SHA ${snapshot.sourceSha} must be the final commit in the source delta`,
      )
    }

    if (sourceHead.sourceDeltaPosition !== orderedSourcePositions.length - 1) {
      throw new RepositoryProjectionInvariantError(
        `Source SHA ${snapshot.sourceSha} must be the final commit in the source delta`,
      )
    }

    if (sourceHead.firstParentPosition !== orderedFirstParentPositions.length - 1) {
      throw new RepositoryProjectionInvariantError(
        `Source SHA ${snapshot.sourceSha} must be the final first-parent integration point`,
      )
    }
  } else if (orderedSourcePositions.length > 0 || orderedFirstParentPositions.length > 0) {
    throw new RepositoryProjectionInvariantError(
      'Source delta and first-parent history must be empty when source and production are equal',
    )
  }

  const pullRequestIds = new Set<string>()
  const pullRequestNumbers = new Set<number>()
  const attributedCommits = new Set<string>()

  for (const change of snapshot.changes) {
    validateChange(change, commits, pullRequestIds, pullRequestNumbers, attributedCommits)
  }

  validateIssues(snapshot.issues)
  const unmanagedIssues = new Set(
    snapshot.issues
      .filter((issue) => issue.code === 'unmanaged_commit' && issue.scope === 'commit')
      .map((issue) => issue.subjectId),
  )
  const ambiguousIssues = new Set(
    snapshot.issues
      .filter((issue) => issue.code === 'ambiguous_commit_attribution' && issue.scope === 'commit')
      .map((issue) => issue.subjectId),
  )

  for (const commit of commits.values()) {
    if (commit.sourceDeltaPosition === null) {
      continue
    }

    const attributed = attributedCommits.has(commit.sha)

    if (commit.attributionState === 'managed' && !attributed) {
      throw new RepositoryProjectionInvariantError(
        `Managed commit ${commit.sha} is not assigned to a Change`,
      )
    }

    if (commit.attributionState !== 'managed' && attributed) {
      throw new RepositoryProjectionInvariantError(
        `${commit.attributionState} commit ${commit.sha} is assigned to a Change`,
      )
    }

    if (commit.attributionState === 'unmanaged' && !unmanagedIssues.has(commit.sha)) {
      throw new RepositoryProjectionInvariantError(
        `Unmanaged commit ${commit.sha} has no synchronization issue`,
      )
    }

    if (commit.attributionState === 'ambiguous' && !ambiguousIssues.has(commit.sha)) {
      throw new RepositoryProjectionInvariantError(
        `Ambiguous commit ${commit.sha} has no synchronization issue`,
      )
    }
  }

  const requiredChecks = new Set<string>()

  for (const check of snapshot.requiredChecks) {
    if (check.id !== undefined) {
      assertLocalId(check.id, 'required check ID')
    }

    assertNonEmpty(check.context, 'required check context')
    const integrationId = serializeNullableGitHubNumericId(
      check.integrationId,
      'required check integration ID',
    )
    const identity = [
      check.context,
      integrationId ?? '',
      check.source,
      check.sourceReference ?? '',
    ].join(':')
    assertUnique(requiredChecks, identity, `Duplicate required check ${identity}`)
  }

  const checkResults = new Set<string>()

  for (const result of snapshot.checkResults) {
    if (result.id !== undefined) {
      assertLocalId(result.id, 'check result ID')
    }

    assertCommitSha(result.commitSha, 'check result commit SHA')
    assertNonEmpty(result.context, 'check result context')
    serializeNullableGitHubNumericId(result.integrationId, 'check result integration ID')
    const githubObjectId = serializeGitHubNumericId(
      result.githubObjectId,
      'check result GitHub object ID',
    )

    if (result.attempt !== null) {
      assertPositiveInteger(result.attempt, 'check result attempt')
    }

    assertValidDate(result.observedAt, 'check result observation time')

    if (result.startedAt !== null) {
      assertValidDate(result.startedAt, 'check result start time')
    }

    if (result.completedAt !== null) {
      assertValidDate(result.completedAt, 'check result completion time')
    }

    const identity = [result.type, githubObjectId, result.attempt ?? 0].join(':')
    assertUnique(checkResults, identity, `Duplicate check result ${identity}`)
  }
}

function assertContiguousPositions(positions: ReadonlySet<number>, name: string): void {
  const ordered = [...positions].sort((left, right) => left - right)

  for (const [expected, actual] of ordered.entries()) {
    if (actual !== expected) {
      throw new RepositoryProjectionInvariantError(
        `${name} positions must be contiguous from zero; expected ${expected}, received ${actual}`,
      )
    }
  }
}

function validateSnapshotAgainstProject(
  snapshot: RepositoryProjectionSnapshot,
  project: ProjectRow,
): void {
  const sourceBranch = snapshot.branches.find((branch) => branch.name === project.source_branch)
  const productionBranch = snapshot.branches.find(
    (branch) => branch.name === project.production_branch,
  )

  if (sourceBranch === undefined) {
    throw new RepositoryProjectionInvariantError(
      [
        `Projection does not contain configured source branch ${project.source_branch}`,
        `at ${snapshot.sourceSha}`,
      ].join(' '),
    )
  }

  if (sourceBranch.headSha !== snapshot.sourceSha) {
    throw new RepositoryProjectionInvariantError(
      [
        `Projection does not contain configured source branch ${project.source_branch}`,
        `at ${snapshot.sourceSha}`,
      ].join(' '),
    )
  }

  if (productionBranch === undefined) {
    throw new RepositoryProjectionInvariantError(
      [
        `Projection does not contain configured production branch ${project.production_branch}`,
        `at ${snapshot.productionSha}`,
      ].join(' '),
    )
  }

  if (productionBranch.headSha !== snapshot.productionSha) {
    throw new RepositoryProjectionInvariantError(
      [
        `Projection does not contain configured production branch ${project.production_branch}`,
        `at ${snapshot.productionSha}`,
      ].join(' '),
    )
  }
}

function validateChange(
  change: ChangeProjection,
  commits: ReadonlyMap<string, RepositoryProjectionSnapshot['commits'][number]>,
  pullRequestIds: Set<string>,
  pullRequestNumbers: Set<number>,
  attributedCommits: Set<string>,
): void {
  if (change.id !== undefined) {
    assertLocalId(change.id, 'change ID')
  }

  const pullRequestId = serializeGitHubNumericId(
    change.githubPullRequestId,
    'GitHub pull request ID',
  )
  assertUnique(pullRequestIds, pullRequestId, `Duplicate GitHub pull request ID ${pullRequestId}`)
  assertPositiveInteger(change.pullRequestNumber, 'pull request number')
  assertUnique(
    pullRequestNumbers,
    change.pullRequestNumber,
    `Duplicate pull request number ${change.pullRequestNumber}`,
  )
  assertNonEmpty(change.title, 'change title')
  serializeNullableGitHubNumericId(change.authorId, 'change author ID')
  assertBranchName(change.baseBranch, 'change base branch')
  assertValidDate(change.mergedAt, 'change merged time')
  assertCommitSha(change.finalHeadSha, 'change final head SHA')

  for (const [value, name] of [
    [change.mergeCommitSha, 'change merge commit SHA'],
    [change.sourceIntegrationSha, 'change source integration SHA'],
    [change.integrationFirstParentSha, 'change integration first parent SHA'],
    [change.integrationSecondParentSha, 'change integration second parent SHA'],
  ] as const) {
    if (value !== null) {
      assertCommitSha(value, name)
    }
  }

  if (change.commitSetFingerprint !== null) {
    assertFingerprint(change.commitSetFingerprint, 'change commit set fingerprint')
  }

  if (
    change.synchronizationState !== 'known' ||
    change.commitSetFingerprint === null ||
    change.sourceIntegrationSha === null ||
    change.integrationFirstParentSha === null ||
    change.commitShas.length === 0 ||
    change.productionPresence === 'unknown'
  ) {
    throw new RepositoryProjectionInvariantError(
      `Managed change #${change.pullRequestNumber} is missing deterministic topology`,
    )
  }

  const expectedFingerprint = createHash('sha256')
    .update(change.commitShas.join('\0'))
    .digest('hex')

  if (expectedFingerprint !== change.commitSetFingerprint) {
    throw new RepositoryProjectionInvariantError(
      `Change #${change.pullRequestNumber} commit-set fingerprint is inconsistent`,
    )
  }

  const integration = commits.get(change.sourceIntegrationSha)

  if (integration === undefined) {
    throw new RepositoryProjectionInvariantError(
      `Change #${change.pullRequestNumber} has an invalid integration commit`,
    )
  }

  if (integration.sourceDeltaPosition === null) {
    throw new RepositoryProjectionInvariantError(
      `Change #${change.pullRequestNumber} has an invalid integration commit`,
    )
  }

  const changeCommits = new Set<string>()
  let previousPosition = -1

  for (const commitSha of change.commitShas) {
    assertCommitSha(commitSha, `commit SHA for change #${change.pullRequestNumber}`)
    assertUnique(
      changeCommits,
      commitSha,
      `Change #${change.pullRequestNumber} contains duplicate commit ${commitSha}`,
    )

    const commit = commits.get(commitSha)

    if (commit === undefined) {
      throw new RepositoryProjectionInvariantError(
        `Change #${change.pullRequestNumber} references commit ${commitSha} outside the source delta`,
      )
    }

    if (commit.sourceDeltaPosition === null) {
      throw new RepositoryProjectionInvariantError(
        `Change #${change.pullRequestNumber} references commit ${commitSha} outside the source delta`,
      )
    }

    if (commit.sourceDeltaPosition <= previousPosition) {
      throw new RepositoryProjectionInvariantError(
        `Change #${change.pullRequestNumber} commit set is not in source topology order`,
      )
    }

    if (
      change.mergeMethod !== 'rebase' &&
      commit.integrationPointSha !== change.sourceIntegrationSha
    ) {
      throw new RepositoryProjectionInvariantError(
        `Change #${change.pullRequestNumber} crosses an invalid integration window`,
      )
    }

    if (
      change.mergeMethod === 'rebase' &&
      (commit.firstParentPosition === null || commit.integrationPointSha !== commit.sha)
    ) {
      throw new RepositoryProjectionInvariantError(
        `Rebase change #${change.pullRequestNumber} contains a non-first-parent commit`,
      )
    }

    previousPosition = commit.sourceDeltaPosition
    assertUnique(
      attributedCommits,
      commitSha,
      `Source commit ${commitSha} is attributed to more than one change`,
    )
  }

  if (change.commitShas.at(-1) !== change.sourceIntegrationSha) {
    throw new RepositoryProjectionInvariantError(
      `Change #${change.pullRequestNumber} integration commit must be last in its commit set`,
    )
  }

  const firstCommit = commits.get(change.commitShas[0] as string)

  if (
    change.mergeMethod !== 'merge' &&
    firstCommit?.parentShas[0] !== change.integrationFirstParentSha
  ) {
    throw new RepositoryProjectionInvariantError(
      `Change #${change.pullRequestNumber} first-parent boundary is inconsistent`,
    )
  }

  if (change.mergeMethod === 'unknown' && change.commitShas.length !== 1) {
    throw new RepositoryProjectionInvariantError(
      `Unknown linear merge method is only valid for one-commit change #${change.pullRequestNumber}`,
    )
  }

  if (change.mergeMethod === 'rebase') {
    const positions = change.commitShas.map((sha) => commits.get(sha)?.firstParentPosition ?? -1)

    for (let index = 1; index < positions.length; index += 1) {
      const previousPosition = positions[index - 1]
      const currentPosition = positions[index]

      if (previousPosition === undefined || currentPosition === undefined) {
        throw new RepositoryProjectionInvariantError(
          `Rebase change #${change.pullRequestNumber} is not contiguous in first-parent history`,
        )
      }

      if (currentPosition !== previousPosition + 1) {
        throw new RepositoryProjectionInvariantError(
          `Rebase change #${change.pullRequestNumber} is not contiguous in first-parent history`,
        )
      }
    }
  }

  if (change.mergeMethod === 'merge') {
    if (
      change.mergeCommitSha !== change.sourceIntegrationSha ||
      integration.parentShas[0] !== change.integrationFirstParentSha ||
      integration.parentShas[1] !== change.integrationSecondParentSha ||
      change.integrationSecondParentSha === null
    ) {
      throw new RepositoryProjectionInvariantError(
        `Merge change #${change.pullRequestNumber} has inconsistent parent topology`,
      )
    }
  } else if (change.integrationSecondParentSha !== null) {
    throw new RepositoryProjectionInvariantError(
      `Linear change #${change.pullRequestNumber} cannot have a second integration parent`,
    )
  }
}

function validateIssues(issues: readonly RepositorySyncIssueProjection[]): void {
  const identities = new Set<string>()

  for (const issue of issues) {
    if (issue.id !== undefined) {
      assertLocalId(issue.id, 'repository synchronization issue ID')
    }

    assertNonEmpty(issue.code, 'repository synchronization issue code')
    assertNonEmpty(issue.message, 'repository synchronization issue message')
    const identity = [issue.code, issue.scope, issue.subjectId ?? ''].join(':')
    assertUnique(identities, identity, `Duplicate repository synchronization issue ${identity}`)
    assertJsonValue(issue.details ?? {})
  }
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    ownerId: row.owner_id,
    ownerLogin: row.owner_login,
    repositoryName: row.repository_name,
    repositoryFullName: row.repository_full_name,
    defaultBranch: row.default_branch,
    sourceBranch: row.source_branch,
    productionBranch: row.production_branch,
    status: row.status,
    sourceSha: row.source_sha,
    productionSha: row.production_sha,
    mergeBaseSha: row.merge_base_sha,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    configurationVersion: row.configuration_version,
    requiredCheckPolicyVersion: row.required_check_policy_version,
    requiredCheckOverrides: parseRequiredCheckOverrides(row.required_check_overrides),
    deletionRequestedAt: row.deletion_requested_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function serializeNullableGitHubNumericId(
  value: number | string | null,
  name: string,
): string | null {
  return value === null ? null : serializeGitHubNumericId(value, name)
}

function assertDashboardProductionPresence(
  value: ChangeProductionPresence,
): Extract<ChangeProductionPresence, 'unreleased' | 'partially_present' | 'unknown'> {
  if (value !== 'unreleased' && value !== 'partially_present' && value !== 'unknown') {
    throw new Error(`Stored change is not visible on the dashboard: ${value}`)
  }

  return value
}

function assertBranchName(value: string, name: string): string {
  const normalized = value.trim()

  if (normalized.length === 0) {
    throw new RepositoryProjectionInvariantError(`${name} must not be empty`)
  }

  if (normalized !== value) {
    throw new RepositoryProjectionInvariantError(`${name} must not contain surrounding whitespace`)
  }

  return normalized
}

function assertCommitSha(value: string, name: string): void {
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw new RepositoryProjectionInvariantError(`${name} must be a lowercase hexadecimal Git SHA`)
  }
}

function assertFingerprint(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new RepositoryProjectionInvariantError(`${name} must be a SHA-256 hexadecimal digest`)
  }
}

function assertLocalId(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new RepositoryProjectionInvariantError(`${name} must not be empty`)
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new RepositoryProjectionInvariantError(`${name} must not be empty`)
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RepositoryProjectionInvariantError(`${name} must be a positive safe integer`)
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RepositoryProjectionInvariantError(`${name} must be a non-negative safe integer`)
  }
}

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RepositoryProjectionInvariantError(`${name} must be a valid Date`)
  }
}

function assertUnique<Value>(collection: Set<Value>, key: Value, message: string): void {
  if (collection.has(key)) {
    throw new RepositoryProjectionInvariantError(message)
  }

  collection.add(key)
}

function assertJsonValue(value: JsonValue): void {
  const serialized = JSON.stringify(value)

  if (serialized === undefined) {
    throw new RepositoryProjectionInvariantError('Synchronization issue details must be JSON')
  }
}
