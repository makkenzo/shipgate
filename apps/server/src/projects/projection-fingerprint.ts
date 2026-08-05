import { createHash } from 'node:crypto'

import type { DatabaseSchema, JsonValue } from '@shipgate/database'
import type { Kysely } from 'kysely'

import type {
  ChangeProjection,
  CommitCheckResultProjection,
  RepositoryCommitProjection,
  RepositoryProjectionSnapshot,
  RepositorySyncIssueProjection,
  RequiredCheckProjection,
} from './model.js'

export interface StoredRepositoryProjectionState {
  readonly fingerprint: string | null
  readonly unknownChangeGitHubPullRequestIds: readonly string[]
}

export function createProjectionFingerprint(snapshot: RepositoryProjectionSnapshot): string {
  return createHash('sha256')
    .update(stableStringify(toSemanticProjection(snapshot)))
    .digest('hex')
}

export async function loadStoredRepositoryProjectionState(
  database: Kysely<DatabaseSchema>,
  projectId: string,
): Promise<StoredRepositoryProjectionState> {
  const project = await database
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', projectId)
    .executeTakeFirst()

  if (
    !project ||
    project.source_sha === null ||
    project.production_sha === null ||
    project.merge_base_sha === null ||
    project.last_successful_sync_at === null
  ) {
    return { fingerprint: null, unknownChangeGitHubPullRequestIds: [] }
  }

  const branches = await database
    .selectFrom('repository_branches')
    .selectAll()
    .where('project_id', '=', projectId)
    .execute()
  const commitRows = await database
    .selectFrom('repository_commits')
    .selectAll()
    .where('project_id', '=', projectId)
    .execute()
  const changeRows = await database
    .selectFrom('changes')
    .selectAll()
    .where('project_id', '=', projectId)
    .execute()
  const changeCommitRows = await database
    .selectFrom('change_commits')
    .select(['change_id', 'commit_sha', 'position'])
    .where('project_id', '=', projectId)
    .orderBy('change_id')
    .orderBy('position')
    .execute()
  const requiredCheckRows =
    project.required_check_policy_version === 0
      ? []
      : await database
          .selectFrom('required_checks')
          .selectAll()
          .where('project_id', '=', projectId)
          .where('policy_version', '=', project.required_check_policy_version)
          .execute()
  const checkResultRows = await database
    .selectFrom('commit_check_results')
    .selectAll()
    .where('project_id', '=', projectId)
    .execute()
  const previousRun = await database
    .selectFrom('repository_sync_runs')
    .select('id')
    .where('project_id', '=', projectId)
    .where('status', '=', 'succeeded')
    .orderBy('completed_at', 'desc')
    .executeTakeFirst()
  const issueRows = previousRun
    ? await database
        .selectFrom('repository_sync_issues')
        .selectAll()
        .where('sync_run_id', '=', previousRun.id)
        .execute()
    : []
  const commitsByChange = new Map<string, string[]>()

  for (const membership of changeCommitRows) {
    const commits = commitsByChange.get(membership.change_id) ?? []
    commits.push(membership.commit_sha)
    commitsByChange.set(membership.change_id, commits)
  }

  const commits: RepositoryCommitProjection[] = commitRows.map((commit) => ({
    sha: commit.sha,
    treeSha: commit.tree_sha,
    message: commit.message,
    authorId: commit.author_id,
    authorLogin: commit.author_login,
    authorName: commit.author_name,
    authorEmail: commit.author_email,
    committerId: commit.committer_id,
    committerLogin: commit.committer_login,
    authoredAt: commit.authored_at,
    committedAt: commit.committed_at,
    parentShas: parseStringArray(commit.parent_shas, 'stored commit parent SHAs'),
    sourceDeltaPosition: commit.source_delta_position,
    firstParentPosition: commit.first_parent_position,
    integrationPointSha: commit.integration_point_sha,
    productionPatchEquivalent: commit.production_patch_equivalent,
    attributionState: commit.attribution_state,
  }))
  const changes: ChangeProjection[] = changeRows.map((change) => ({
    githubPullRequestId: change.github_pull_request_id,
    pullRequestNumber: change.pull_request_number,
    title: change.title,
    url: change.url,
    authorId: change.author_id,
    authorLogin: change.author_login,
    baseBranch: change.base_branch,
    mergedAt: change.merged_at,
    finalHeadSha: change.final_head_sha,
    mergeCommitSha: change.merge_commit_sha,
    sourceIntegrationSha: change.source_integration_sha,
    integrationFirstParentSha: change.integration_first_parent_sha,
    integrationSecondParentSha: change.integration_second_parent_sha,
    mergeMethod: change.merge_method,
    commitSetFingerprint: change.commit_set_fingerprint,
    synchronizationState: change.synchronization_state,
    productionPresence: change.production_presence,
    commitShas: commitsByChange.get(change.id) ?? [],
  }))
  const requiredChecks: RequiredCheckProjection[] = requiredCheckRows.map((check) => ({
    context: check.context,
    integrationId: parseNullableSafeGitHubId(check.integration_id, 'required check integration ID'),
    source: check.source,
    sourceReference: check.source_reference,
  }))
  const checkResults: CommitCheckResultProjection[] = checkResultRows.map((result) => ({
    commitSha: result.commit_sha,
    type: result.check_type,
    context: result.context,
    integrationId: result.integration_id,
    githubObjectId: result.github_object_id,
    attempt: result.attempt,
    status: result.status,
    conclusion: result.conclusion,
    detailsUrl: result.details_url,
    startedAt: result.started_at,
    completedAt: result.completed_at,
    observedAt: result.observed_at,
  }))
  const issues: RepositorySyncIssueProjection[] = issueRows.map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    scope: issue.scope,
    subjectId: issue.subject_id,
    message: issue.message,
    details: issue.details,
  }))
  const snapshot: RepositoryProjectionSnapshot = {
    installationId: project.installation_id,
    ownerId: project.owner_id,
    ownerLogin: project.owner_login,
    repositoryName: project.repository_name,
    repositoryFullName: project.repository_full_name,
    defaultBranch: project.default_branch,
    sourceSha: project.source_sha,
    productionSha: project.production_sha,
    mergeBaseSha: project.merge_base_sha,
    observedAt: project.last_successful_sync_at,
    branches: branches.map((branch) => ({
      name: branch.name,
      headSha: branch.head_sha,
      protected: branch.protected,
      defaultBranch: branch.default_branch,
    })),
    commits,
    changes,
    requiredChecks,
    checkResults,
    issues,
  }

  return {
    fingerprint: createProjectionFingerprint(snapshot),
    unknownChangeGitHubPullRequestIds: changeRows
      .filter((change) => change.synchronization_state === 'unknown')
      .map((change) => change.github_pull_request_id)
      .toSorted(),
  }
}

function toSemanticProjection(snapshot: RepositoryProjectionSnapshot): JsonValue {
  return {
    repository: {
      installationId: normalizeGitHubId(snapshot.installationId),
      ownerId: normalizeGitHubId(snapshot.ownerId),
      ownerLogin: snapshot.ownerLogin,
      repositoryName: snapshot.repositoryName,
      repositoryFullName: snapshot.repositoryFullName,
      defaultBranch: snapshot.defaultBranch,
      sourceSha: snapshot.sourceSha,
      productionSha: snapshot.productionSha,
      mergeBaseSha: snapshot.mergeBaseSha,
    },
    branches: snapshot.branches
      .map((branch) => ({
        name: branch.name,
        headSha: branch.headSha,
        protected: branch.protected,
        defaultBranch: branch.defaultBranch,
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
    commits: snapshot.commits
      .map((commit) => ({
        sha: commit.sha,
        treeSha: commit.treeSha,
        message: commit.message,
        authorId: normalizeNullableGitHubId(commit.authorId),
        authorLogin: commit.authorLogin,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        committerId: normalizeNullableGitHubId(commit.committerId),
        committerLogin: commit.committerLogin,
        authoredAt: commit.authoredAt?.toISOString() ?? null,
        committedAt: commit.committedAt.toISOString(),
        parentShas: commit.parentShas,
        sourceDeltaPosition: commit.sourceDeltaPosition,
        firstParentPosition: commit.firstParentPosition,
        integrationPointSha: commit.integrationPointSha,
        productionPatchEquivalent: commit.productionPatchEquivalent,
        attributionState: commit.attributionState,
      }))
      .toSorted(compareCommits),
    changes: snapshot.changes
      .map((change) => ({
        githubPullRequestId: normalizeGitHubId(change.githubPullRequestId),
        pullRequestNumber: change.pullRequestNumber,
        title: change.title,
        url: change.url,
        authorId: normalizeNullableGitHubId(change.authorId),
        authorLogin: change.authorLogin,
        baseBranch: change.baseBranch,
        mergedAt: change.mergedAt.toISOString(),
        finalHeadSha: change.finalHeadSha,
        mergeCommitSha: change.mergeCommitSha,
        sourceIntegrationSha: change.sourceIntegrationSha,
        integrationFirstParentSha: change.integrationFirstParentSha,
        integrationSecondParentSha: change.integrationSecondParentSha,
        mergeMethod: change.mergeMethod,
        commitSetFingerprint: change.commitSetFingerprint,
        synchronizationState: change.synchronizationState,
        productionPresence: change.productionPresence,
        commitShas: change.commitShas,
      }))
      .toSorted(compareChanges),
    requiredChecks: snapshot.requiredChecks
      .map((check) => ({
        context: check.context,
        integrationId: normalizeNullableGitHubId(check.integrationId),
        source: check.source,
        sourceReference: check.sourceReference,
      }))
      .toSorted(compareRequiredChecks),
    checkResults: snapshot.checkResults
      .map((result) => ({
        commitSha: result.commitSha,
        type: result.type,
        context: result.context,
        integrationId: normalizeNullableGitHubId(result.integrationId),
        githubObjectId: normalizeGitHubId(result.githubObjectId),
        attempt: result.attempt,
        status: result.status,
        conclusion: result.conclusion,
        detailsUrl: result.detailsUrl,
        startedAt: result.startedAt?.toISOString() ?? null,
        completedAt: result.completedAt?.toISOString() ?? null,
      }))
      .toSorted(compareCheckResults),
    issues: snapshot.issues
      .map((issue) => ({
        severity: issue.severity,
        code: issue.code,
        scope: issue.scope,
        subjectId: issue.subjectId,
        message: issue.message,
        details: issue.details ?? {},
      }))
      .toSorted(compareIssues),
  }
}

function compareCommits(
  left: ReturnType<typeof toSemanticProjectionCommit>,
  right: ReturnType<typeof toSemanticProjectionCommit>,
): number {
  return (
    compareNullableNumber(left.sourceDeltaPosition, right.sourceDeltaPosition) ||
    compareNullableNumber(left.firstParentPosition, right.firstParentPosition) ||
    left.committedAt.localeCompare(right.committedAt) ||
    left.sha.localeCompare(right.sha)
  )
}

function toSemanticProjectionCommit(commit: RepositoryCommitProjection) {
  return {
    sha: commit.sha,
    committedAt: commit.committedAt.toISOString(),
    sourceDeltaPosition: commit.sourceDeltaPosition,
    firstParentPosition: commit.firstParentPosition,
  }
}

function compareChanges(
  left: { readonly mergedAt: string; readonly pullRequestNumber: number },
  right: { readonly mergedAt: string; readonly pullRequestNumber: number },
): number {
  return (
    left.mergedAt.localeCompare(right.mergedAt) || left.pullRequestNumber - right.pullRequestNumber
  )
}

function compareRequiredChecks(
  left: {
    readonly context: string
    readonly integrationId: string | null
    readonly source: string
    readonly sourceReference: string | null
  },
  right: {
    readonly context: string
    readonly integrationId: string | null
    readonly source: string
    readonly sourceReference: string | null
  },
): number {
  return (
    left.context.localeCompare(right.context) ||
    (left.integrationId ?? '').localeCompare(right.integrationId ?? '') ||
    left.source.localeCompare(right.source) ||
    (left.sourceReference ?? '').localeCompare(right.sourceReference ?? '')
  )
}

function compareCheckResults(
  left: {
    readonly commitSha: string
    readonly type: string
    readonly context: string
    readonly integrationId: string | null
    readonly githubObjectId: string
    readonly attempt: number | null
  },
  right: {
    readonly commitSha: string
    readonly type: string
    readonly context: string
    readonly integrationId: string | null
    readonly githubObjectId: string
    readonly attempt: number | null
  },
): number {
  return (
    left.commitSha.localeCompare(right.commitSha) ||
    left.type.localeCompare(right.type) ||
    left.context.localeCompare(right.context) ||
    (left.integrationId ?? '').localeCompare(right.integrationId ?? '') ||
    compareDecimalIds(left.githubObjectId, right.githubObjectId) ||
    (left.attempt ?? 0) - (right.attempt ?? 0)
  )
}

function compareIssues(
  left: {
    readonly severity: string
    readonly code: string
    readonly scope: string
    readonly subjectId: string | null
    readonly message: string
    readonly details: JsonValue
  },
  right: {
    readonly severity: string
    readonly code: string
    readonly scope: string
    readonly subjectId: string | null
    readonly message: string
    readonly details: JsonValue
  },
): number {
  return (
    left.severity.localeCompare(right.severity) ||
    left.code.localeCompare(right.code) ||
    left.scope.localeCompare(right.scope) ||
    (left.subjectId ?? '').localeCompare(right.subjectId ?? '') ||
    left.message.localeCompare(right.message) ||
    stableStringify(left.details).localeCompare(stableStringify(right.details))
  )
}

function compareNullableNumber(left: number | null, right: number | null): number {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  return left - right
}

function compareDecimalIds(left: string, right: string): number {
  const leftId = BigInt(left)
  const rightId = BigInt(right)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

function normalizeGitHubId(value: number | string): string {
  return String(value)
}

function normalizeNullableGitHubId(value: number | string | null): string | null {
  return value === null ? null : normalizeGitHubId(value)
}

function parseNullableSafeGitHubId(value: string | null, name: string): number | null {
  if (value === null) return null
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} is outside JavaScript's safe integer range: ${value}`)
  }

  return parsed
}

function parseStringArray(value: JsonValue, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${name} is invalid`)
  }

  return value
}

function stableStringify(value: JsonValue): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }

  if (typeof value !== 'object' || value === null) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  )
}
