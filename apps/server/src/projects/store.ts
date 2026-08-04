import { randomUUID } from 'node:crypto'

import type {
  ChangeMergeMethod,
  ChangeProductionPresence,
  DatabaseClient,
  DatabaseSchema,
  JsonValue,
  ProjectTable,
} from '@shipgate/database'
import type { Selectable, Transaction } from 'kysely'

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

  const storedChanges = await prepareStoredChanges(
    transaction,
    input.projectId,
    input.snapshot.changes,
  )
  const syncRunId = existingRun?.id ?? input.syncRunId ?? randomUUID()
  const observedAt = input.snapshot.observedAt

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
          observed_at: observedAt,
          updated_at: observedAt,
        })),
      )
      .execute()
  }

  await pruneMissingChanges(
    transaction,
    input.projectId,
    storedChanges.map((change) => change.githubPullRequestId),
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

  if (input.snapshot.requiredChecks.length > 0) {
    await transaction
      .insertInto('required_checks')
      .values(
        input.snapshot.requiredChecks.map((check) => ({
          id: check.id ?? randomUUID(),
          project_id: input.projectId,
          repository_id: repositoryId,
          policy_version: check.policyVersion,
          check_type: check.type,
          context: check.context,
          integration_id: serializeNullableGitHubNumericId(
            check.integrationId,
            'required check integration ID',
          ),
          source: check.source,
          source_reference: check.sourceReference,
          observed_at: observedAt,
          updated_at: observedAt,
        })),
      )
      .execute()
  }

  if (input.snapshot.checkResults.length > 0) {
    await transaction
      .insertInto('commit_check_results')
      .values(
        input.snapshot.checkResults.map((result) => ({
          id: result.id ?? randomUUID(),
          project_id: input.projectId,
          repository_id: repositoryId,
          commit_sha: result.commitSha,
          check_type: result.type,
          context: result.context,
          integration_id: serializeNullableGitHubNumericId(
            result.integrationId,
            'check result integration ID',
          ),
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
        })),
      )
      .execute()
  }

  await insertSynchronizationIssues(
    transaction,
    input.projectId,
    repositoryId,
    syncRunId,
    input.snapshot.issues,
  )

  const updated = await transaction
    .updateTable('projects')
    .set({
      installation_id: serializeGitHubNumericId(input.snapshot.installationId, 'installation ID'),
      owner_id: serializeGitHubNumericId(input.snapshot.ownerId, 'repository owner ID'),
      owner_login: input.snapshot.ownerLogin,
      repository_name: input.snapshot.repositoryName,
      repository_full_name: input.snapshot.repositoryFullName,
      default_branch: input.snapshot.defaultBranch,
      status: 'active',
      source_sha: input.snapshot.sourceSha,
      production_sha: input.snapshot.productionSha,
      last_successful_sync_at: input.completedAt,
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
      })
      .execute()

    await insertSynchronizationIssues(
      transaction,
      input.projectId,
      repositoryId,
      syncRunId,
      input.issues,
    )

    if (input.disconnectProject === true) {
      await transaction
        .updateTable('projects')
        .set({
          status: 'disconnected',
          updated_at: input.completedAt,
        })
        .where('id', '=', input.projectId)
        .where('status', 'in', ['active', 'disconnected'])
        .execute()
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

  const rows = await database.kysely
    .selectFrom('changes')
    .select([
      'id',
      'github_pull_request_id',
      'pull_request_number',
      'title',
      'author_id',
      'author_login',
      'merged_at',
      'merge_method',
      'commit_set_fingerprint',
      'production_presence',
    ])
    .where('project_id', '=', projectId)
    .where('synchronization_state', '=', 'known')
    .where('production_presence', 'in', ['missing', 'not_applicable'])
    .orderBy('merged_at')
    .orderBy('pull_request_number')
    .execute()

  if (rows.length === 0) {
    return []
  }

  const commitRows = await database.kysely
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

  return rows.map((row) => {
    const mergeMethod = assertKnownMergeMethod(row.merge_method)
    const fingerprint = row.commit_set_fingerprint
    const productionPresence = assertAheadProductionPresence(row.production_presence)

    if (!fingerprint) {
      throw new Error(`Known change ${row.id} has no commit set fingerprint`)
    }

    return {
      id: row.id,
      githubPullRequestId: row.github_pull_request_id,
      pullRequestNumber: row.pull_request_number,
      title: row.title,
      authorId: row.author_id,
      authorLogin: row.author_login,
      mergedAt: row.merged_at,
      mergeMethod,
      commitSetFingerprint: fingerprint,
      productionPresence,
      commitShas: commitsByChange.get(row.id) ?? [],
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

async function pruneMissingChanges(
  transaction: ProjectWriteTransaction,
  projectId: string,
  githubPullRequestIds: readonly string[],
): Promise<void> {
  let query = transaction.deleteFrom('changes').where('project_id', '=', projectId)

  if (githubPullRequestIds.length > 0) {
    query = query.where('github_pull_request_id', 'not in', githubPullRequestIds)
  }

  await query.execute()
}

async function clearCurrentProjection(
  transaction: ProjectWriteTransaction,
  projectId: string,
): Promise<void> {
  await transaction.deleteFrom('commit_check_results').where('project_id', '=', projectId).execute()
  await transaction.deleteFrom('required_checks').where('project_id', '=', projectId).execute()
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
  assertValidDate(snapshot.observedAt, 'projection observation time')

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
    }
  }

  const orderedSourcePositions = [...sourcePositions].sort((left, right) => left - right)

  for (const [expectedPosition, actualPosition] of orderedSourcePositions.entries()) {
    if (actualPosition !== expectedPosition) {
      throw new RepositoryProjectionInvariantError(
        [
          'Source delta positions must be contiguous from zero;',
          `expected ${expectedPosition}, received ${actualPosition}`,
        ].join(' '),
      )
    }
  }

  if (snapshot.sourceSha !== snapshot.productionSha) {
    const sourceHead = commits.get(snapshot.sourceSha)
    const expectedSourcePosition = orderedSourcePositions.length - 1

    if (!sourceHead || sourceHead.sourceDeltaPosition !== expectedSourcePosition) {
      throw new RepositoryProjectionInvariantError(
        `Source SHA ${snapshot.sourceSha} must be the final commit in the source delta`,
      )
    }
  } else if (orderedSourcePositions.length > 0) {
    throw new RepositoryProjectionInvariantError(
      'Source delta must be empty when source and production SHA are equal',
    )
  }

  const pullRequestIds = new Set<string>()
  const pullRequestNumbers = new Set<number>()
  const attributedCommits = new Set<string>()

  for (const change of snapshot.changes) {
    validateChange(change, commits, pullRequestIds, pullRequestNumbers, attributedCommits)
  }

  const requiredChecks = new Set<string>()
  const requiredCheckPolicyVersions = new Set<number>()

  for (const check of snapshot.requiredChecks) {
    if (check.id !== undefined) {
      assertLocalId(check.id, 'required check ID')
    }

    assertPositiveInteger(check.policyVersion, 'required check policy version')
    requiredCheckPolicyVersions.add(check.policyVersion)
    assertNonEmpty(check.context, 'required check context')
    const integrationId = serializeNullableGitHubNumericId(
      check.integrationId,
      'required check integration ID',
    )
    const identity = [check.policyVersion, check.type, check.context, integrationId ?? ''].join(':')
    assertUnique(requiredChecks, identity, `Duplicate required check ${identity}`)
  }

  if (requiredCheckPolicyVersions.size > 1) {
    throw new RepositoryProjectionInvariantError(
      'A repository projection must contain exactly one required-check policy version',
    )
  }

  const checkResults = new Set<string>()

  for (const result of snapshot.checkResults) {
    if (result.id !== undefined) {
      assertLocalId(result.id, 'check result ID')
    }

    assertCommitSha(result.commitSha, 'check result commit SHA')

    if (!commits.has(result.commitSha)) {
      throw new RepositoryProjectionInvariantError(
        `Check result ${result.context} references unknown commit ${result.commitSha}`,
      )
    }

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

  validateIssues(snapshot.issues)
}

function validateSnapshotAgainstProject(
  snapshot: RepositoryProjectionSnapshot,
  project: ProjectRow,
): void {
  const sourceBranch = snapshot.branches.find((branch) => branch.name === project.source_branch)
  const productionBranch = snapshot.branches.find(
    (branch) => branch.name === project.production_branch,
  )

  if (!sourceBranch || sourceBranch.headSha !== snapshot.sourceSha) {
    throw new RepositoryProjectionInvariantError(
      [
        `Projection does not contain configured source branch ${project.source_branch}`,
        `at ${snapshot.sourceSha}`,
      ].join(' '),
    )
  }

  if (!productionBranch || productionBranch.headSha !== snapshot.productionSha) {
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

  if (change.mergeCommitSha !== null) {
    assertCommitSha(change.mergeCommitSha, 'change merge commit SHA')
  }

  if (change.sourceIntegrationSha !== null) {
    assertCommitSha(change.sourceIntegrationSha, 'change source integration SHA')
  }

  if (change.commitSetFingerprint !== null) {
    assertFingerprint(change.commitSetFingerprint, 'change commit set fingerprint')
  }

  if (change.synchronizationState === 'known') {
    if (
      change.mergeMethod === 'unknown' ||
      change.commitSetFingerprint === null ||
      change.sourceIntegrationSha === null ||
      change.commitShas.length === 0
    ) {
      throw new RepositoryProjectionInvariantError(
        [
          `Known change #${change.pullRequestNumber} requires a merge method,`,
          'integration SHA, fingerprint and non-empty commit set',
        ].join(' '),
      )
    }
  }

  const changeCommits = new Set<string>()

  for (const commitSha of change.commitShas) {
    assertCommitSha(commitSha, `commit SHA for change #${change.pullRequestNumber}`)
    assertUnique(
      changeCommits,
      commitSha,
      `Change #${change.pullRequestNumber} contains duplicate commit ${commitSha}`,
    )

    const commit = commits.get(commitSha)

    if (!commit) {
      throw new RepositoryProjectionInvariantError(
        `Change #${change.pullRequestNumber} references unknown commit ${commitSha}`,
      )
    }

    if (commit.sourceDeltaPosition === null) {
      throw new RepositoryProjectionInvariantError(
        [
          `Change #${change.pullRequestNumber} references commit ${commitSha}`,
          'outside the source delta',
        ].join(' '),
      )
    }

    assertUnique(
      attributedCommits,
      commitSha,
      `Source commit ${commitSha} is attributed to more than one change`,
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
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    configurationVersion: row.configuration_version,
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

function assertKnownMergeMethod(value: ChangeMergeMethod): Exclude<ChangeMergeMethod, 'unknown'> {
  if (value === 'unknown') {
    throw new Error('A known change cannot have an unknown merge method')
  }

  return value
}

function assertAheadProductionPresence(
  value: ChangeProductionPresence,
): Extract<ChangeProductionPresence, 'missing' | 'not_applicable'> {
  if (value !== 'missing' && value !== 'not_applicable') {
    throw new Error(`Change is not ahead of production: ${value}`)
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
