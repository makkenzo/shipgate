import { createHash } from 'node:crypto'

import type { InstallationGitHubClient, InstallationPermissions } from '@shipgate/github'
import { ProjectConfigurationValidationError } from './errors.js'
import type { GitRepositorySnapshot } from './git-workspace.js'
import type {
  CommitCheckResultProjection,
  RepositoryBranchProjection,
  RepositoryCommitProjection,
  RepositoryProjectionSnapshot,
  RequiredCheckProjection,
} from './model.js'
import { attributePullRequestChanges } from './pr-attribution.js'

const pageSize = 100
const maximumPages = 100

const syncPermissions = {
  metadata: 'read',
  contents: 'read',
  pull_requests: 'read',
  checks: 'read',
  statuses: 'read',
  administration: 'read',
} as const satisfies InstallationPermissions

export interface RepositoryInitialSyncTarget {
  readonly installationId: number
  readonly repositoryId: number
  readonly configurationVersion: number
  readonly sourceBranch: string
  readonly productionBranch: string
}

export interface RepositoryHeadState {
  readonly sourceSha: string
  readonly productionSha: string
  readonly sourceProtected: boolean
  readonly productionProtected: boolean
}

export interface RepositoryMetadata {
  readonly ownerId: number
  readonly ownerLogin: string
  readonly name: string
  readonly fullName: string
  readonly cloneUrl: string
  readonly defaultBranch: string | null
}

export async function loadRepositoryMetadata(
  client: InstallationGitHubClient,
  repositoryId: number,
): Promise<RepositoryMetadata> {
  let response: Awaited<ReturnType<InstallationGitHubClient['request']>>

  try {
    response = await client.request('GET /repositories/{repository_id}', {
      repository_id: repositoryId,
    })
  } catch (error) {
    if (getStatus(error) === 404) {
      throw new ProjectConfigurationValidationError(
        'repository_unavailable',
        `Repository ${repositoryId} is no longer accessible to the GitHub App installation`,
        { cause: error },
      )
    }

    throw error
  }

  const value = requireRecord(response.data, 'repository')
  const owner = requireRecord(value.owner, 'repository owner')
  const actualId = requirePositiveInteger(value.id, 'repository ID')

  if (actualId !== repositoryId) {
    throw new ProjectConfigurationValidationError(
      'external_state_unknown',
      `GitHub returned repository ${actualId}, expected ${repositoryId}`,
    )
  }

  if (value.archived === true || value.disabled === true) {
    throw new ProjectConfigurationValidationError(
      'repository_unavailable',
      value.archived === true ? 'Repository is archived' : 'Repository is disabled',
    )
  }

  return {
    ownerId: requirePositiveInteger(owner.id, 'repository owner ID'),
    ownerLogin: requireString(owner.login, 'repository owner login'),
    name: requireString(value.name, 'repository name'),
    fullName: requireString(value.full_name, 'repository full name'),
    cloneUrl: requireString(value.clone_url, 'repository clone URL'),
    defaultBranch: nullableString(value.default_branch),
  }
}

export async function resolveRepositoryHeads(
  client: InstallationGitHubClient,
  metadata: RepositoryMetadata,
  sourceBranch: string,
  productionBranch: string,
): Promise<RepositoryHeadState> {
  const [source, production] = await Promise.all([
    loadBranch(client, metadata, sourceBranch, 'source'),
    loadBranch(client, metadata, productionBranch, 'production'),
  ])

  return {
    sourceSha: source.sha,
    productionSha: production.sha,
    sourceProtected: source.protected,
    productionProtected: production.protected,
  }
}

export async function buildRepositoryProjectionSnapshot(input: {
  readonly client: InstallationGitHubClient
  readonly target: RepositoryInitialSyncTarget
  readonly metadata: RepositoryMetadata
  readonly heads: RepositoryHeadState
  readonly git: GitRepositorySnapshot
  readonly observedAt: Date
}): Promise<RepositoryProjectionSnapshot> {
  const commits: RepositoryCommitProjection[] = input.git.commits.map((commit) => ({
    sha: commit.sha,
    treeSha: commit.treeSha,
    message: commit.message,
    authorId: null,
    authorLogin: null,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    committerId: null,
    committerLogin: null,
    authoredAt: commit.authoredAt,
    committedAt: commit.committedAt,
    parentShas: commit.parentShas,
    sourceDeltaPosition: commit.sourceDeltaPosition,
    firstParentPosition: commit.firstParentPosition,
    integrationPointSha: commit.integrationPointSha,
    productionPatchEquivalent: commit.productionPatchEquivalent,
    attributionState: 'unmanaged',
  }))
  const attribution = await attributePullRequestChanges({
    client: input.client,
    repository: {
      ownerLogin: input.metadata.ownerLogin,
      name: input.metadata.name,
    },
    sourceBranch: input.target.sourceBranch,
    git: input.git,
    commits,
  })
  const requiredChecks = await loadRequiredChecks({
    client: input.client,
    metadata: input.metadata,
    sourceBranch: input.target.sourceBranch,
    policyVersion: input.target.configurationVersion,
  })
  const checkResults = await loadActualCheckResults({
    client: input.client,
    metadata: input.metadata,
    sourceSha: input.heads.sourceSha,
    observedAt: input.observedAt,
  })

  return {
    installationId: input.target.installationId,
    ownerId: input.metadata.ownerId,
    ownerLogin: input.metadata.ownerLogin,
    repositoryName: input.metadata.name,
    repositoryFullName: input.metadata.fullName,
    defaultBranch: input.metadata.defaultBranch,
    sourceSha: input.heads.sourceSha,
    productionSha: input.heads.productionSha,
    mergeBaseSha: input.git.mergeBaseSha,
    observedAt: input.observedAt,
    branches: createBranchProjection(input),
    commits: attribution.commits,
    changes: attribution.changes,
    requiredChecks,
    checkResults,
    issues: attribution.issues,
  }
}

export function createProjectionFingerprint(snapshot: RepositoryProjectionSnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify(snapshot, (_key, value) =>
        value instanceof Date ? value.toISOString() : value,
      ),
    )
    .digest('hex')
}

export { syncPermissions as repositoryInitialSyncPermissions }

function createBranchProjection(input: {
  readonly target: RepositoryInitialSyncTarget
  readonly metadata: RepositoryMetadata
  readonly heads: RepositoryHeadState
}): readonly RepositoryBranchProjection[] {
  return [
    {
      name: input.target.sourceBranch,
      headSha: input.heads.sourceSha,
      protected: input.heads.sourceProtected,
      defaultBranch: input.metadata.defaultBranch === input.target.sourceBranch,
    },
    {
      name: input.target.productionBranch,
      headSha: input.heads.productionSha,
      protected: input.heads.productionProtected,
      defaultBranch: input.metadata.defaultBranch === input.target.productionBranch,
    },
  ]
}

async function loadBranch(
  client: InstallationGitHubClient,
  metadata: RepositoryMetadata,
  branch: string,
  role: 'source' | 'production',
): Promise<{ readonly sha: string; readonly protected: boolean }> {
  let refResponse: Awaited<ReturnType<InstallationGitHubClient['request']>>

  try {
    refResponse = await client.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
      owner: metadata.ownerLogin,
      repo: metadata.name,
      ref: `heads/${branch}`,
    })
  } catch (error) {
    if (getStatus(error) === 404) {
      throw new ProjectConfigurationValidationError(
        role === 'source' ? 'source_branch_missing' : 'production_branch_missing',
        `${role === 'source' ? 'Source' : 'Production'} branch ${branch} no longer exists`,
        { cause: error },
      )
    }

    throw error
  }

  const ref = requireRecord(refResponse.data, `branch ref ${branch}`)
  const object = requireRecord(ref.object, `branch ref object ${branch}`)

  if (ref.ref !== `refs/heads/${branch}` || object.type !== 'commit') {
    throw new ProjectConfigurationValidationError(
      role === 'source' ? 'source_ref_not_commit' : 'production_ref_not_commit',
      `Branch ${branch} does not resolve directly to a commit`,
    )
  }

  const sha = requireSha(object.sha, `branch ${branch} SHA`)
  let branchResponse: Awaited<ReturnType<InstallationGitHubClient['request']>>

  try {
    branchResponse = await client.request('GET /repos/{owner}/{repo}/branches/{branch}', {
      owner: metadata.ownerLogin,
      repo: metadata.name,
      branch,
    })
  } catch (error) {
    if (getStatus(error) === 404) {
      throw new ProjectConfigurationValidationError(
        role === 'source' ? 'source_branch_missing' : 'production_branch_missing',
        `${role === 'source' ? 'Source' : 'Production'} branch ${branch} no longer exists`,
        { cause: error },
      )
    }

    throw error
  }

  const branchValue = requireRecord(branchResponse.data, `branch ${branch}`)
  const commit = requireRecord(branchValue.commit, `branch ${branch} commit`)

  if (requireSha(commit.sha, `branch ${branch} commit SHA`) !== sha) {
    throw new ProjectConfigurationValidationError(
      'repository_state_changed',
      `GitHub branch ${branch} metadata and ref disagree`,
    )
  }

  return { sha, protected: branchValue.protected === true }
}

async function loadRequiredChecks(input: {
  readonly client: InstallationGitHubClient
  readonly metadata: RepositoryMetadata
  readonly sourceBranch: string
  readonly policyVersion: number
}): Promise<readonly RequiredCheckProjection[]> {
  const checks = new Map<string, RequiredCheckProjection>()
  const policyVersion = input.policyVersion

  try {
    const response = await input.client.request(
      'GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks',
      {
        owner: input.metadata.ownerLogin,
        repo: input.metadata.name,
        branch: input.sourceBranch,
      },
    )
    const value = requireRecord(response.data, 'required status checks')

    const branchChecks = Array.isArray(value.checks) ? value.checks : []
    const structuredContexts = new Set<string>()

    for (const item of branchChecks) {
      const check = requireRecord(item, 'required branch check')
      const context = requireString(check.context, 'required branch check context')
      structuredContexts.add(context)
      addRequiredCheck(checks, {
        policyVersion,
        type: 'check_run',
        context,
        integrationId: nullablePositiveInteger(check.app_id),
        source: 'branch_protection',
        sourceReference: input.sourceBranch,
      })
    }

    for (const context of Array.isArray(value.contexts) ? value.contexts : []) {
      if (typeof context === 'string' && context.length > 0 && !structuredContexts.has(context)) {
        addRequiredCheck(checks, {
          policyVersion,
          type: 'commit_status',
          context,
          integrationId: null,
          source: 'branch_protection',
          sourceReference: input.sourceBranch,
        })
      }
    }
  } catch (error) {
    if (getStatus(error) !== 404) {
      throw error
    }
  }

  try {
    const summaries: unknown[] = []

    let rulesetsComplete = false

    for (let page = 1; page <= maximumPages; page += 1) {
      const response = await input.client.request('GET /repos/{owner}/{repo}/rulesets', {
        owner: input.metadata.ownerLogin,
        repo: input.metadata.name,
        includes_parents: true,
        per_page: pageSize,
        page,
      })
      const pageItems = requireArray(response.data, 'repository rulesets')
      summaries.push(...pageItems)

      if (pageItems.length < pageSize) {
        rulesetsComplete = true
        break
      }
    }

    if (!rulesetsComplete) {
      throw incompletePaginationError('repository rulesets')
    }

    for (const item of summaries) {
      const summary = requireRecord(item, 'repository ruleset')
      const id = requirePositiveInteger(summary.id, 'repository ruleset ID')
      const detailResponse = await input.client.request(
        'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}',
        {
          owner: input.metadata.ownerLogin,
          repo: input.metadata.name,
          ruleset_id: id,
        },
      )
      const detail = requireRecord(detailResponse.data, 'repository ruleset detail')

      if (detail.enforcement === 'disabled' || !rulesetMatchesBranch(detail, input)) {
        continue
      }

      for (const itemRule of Array.isArray(detail.rules) ? detail.rules : []) {
        const rule = requireRecord(itemRule, 'repository rule')

        if (rule.type !== 'required_status_checks') {
          continue
        }

        const parameters = requireRecord(rule.parameters, 'required status checks parameters')
        const required = Array.isArray(parameters.required_status_checks)
          ? parameters.required_status_checks
          : []

        for (const requiredItem of required) {
          const requiredCheck = requireRecord(requiredItem, 'ruleset required check')
          const context = requireString(requiredCheck.context, 'ruleset required check context')
          const integrationId = nullablePositiveInteger(requiredCheck.integration_id)
          addRequiredCheck(checks, {
            policyVersion,
            type: integrationId === null ? 'commit_status' : 'check_run',
            context,
            integrationId,
            source: 'repository_ruleset',
            sourceReference: String(id),
          })
        }
      }
    }
  } catch (error) {
    if (getStatus(error) !== 404) {
      throw error
    }
  }

  return [...checks.values()].sort((left, right) => left.context.localeCompare(right.context))
}

function rulesetMatchesBranch(
  ruleset: Readonly<Record<string, unknown>>,
  input: { readonly metadata: RepositoryMetadata; readonly sourceBranch: string },
): boolean {
  if (ruleset.target !== undefined && ruleset.target !== 'branch') {
    return false
  }

  const conditions = isRecord(ruleset.conditions) ? ruleset.conditions : undefined
  const refName = conditions && isRecord(conditions.ref_name) ? conditions.ref_name : undefined

  if (!refName) {
    return true
  }

  const include = stringArray(refName.include)
  const exclude = stringArray(refName.exclude)
  const candidates = [
    `refs/heads/${input.sourceBranch}`,
    input.sourceBranch,
    input.metadata.defaultBranch === input.sourceBranch ? '~DEFAULT_BRANCH' : '',
    '~ALL',
  ].filter(Boolean)

  const included =
    include.length === 0 ||
    include.some((pattern) => candidates.some((candidate) => globMatches(pattern, candidate)))
  const excluded = exclude.some((pattern) =>
    candidates.some((candidate) => globMatches(pattern, candidate)),
  )

  return included && !excluded
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern === '~ALL' || pattern === value) {
    return true
  }

  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

async function loadActualCheckResults(input: {
  readonly client: InstallationGitHubClient
  readonly metadata: RepositoryMetadata
  readonly sourceSha: string
  readonly observedAt: Date
}): Promise<readonly CommitCheckResultProjection[]> {
  const results: CommitCheckResultProjection[] = []

  let checkRunsComplete = false

  for (let page = 1; page <= maximumPages; page += 1) {
    const response = await input.client.request(
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      {
        owner: input.metadata.ownerLogin,
        repo: input.metadata.name,
        ref: input.sourceSha,
        per_page: pageSize,
        page,
        filter: 'all',
      },
    )
    const body = requireRecord(response.data, 'check runs response')
    const pageItems = Array.isArray(body.check_runs) ? body.check_runs : []

    for (const item of pageItems) {
      const check = requireRecord(item, 'check run')
      const app = isRecord(check.app) ? check.app : undefined
      results.push({
        commitSha: input.sourceSha,
        type: 'check_run',
        context: requireString(check.name, 'check run name'),
        integrationId: app ? nullablePositiveInteger(app.id) : null,
        githubObjectId: requirePositiveInteger(check.id, 'check run ID'),
        attempt: nullablePositiveInteger(check.run_attempt),
        status: normalizeCheckRunStatus(check.status),
        conclusion: normalizeCheckConclusion(check.conclusion),
        detailsUrl: nullableString(check.details_url),
        startedAt: nullableDate(check.started_at),
        completedAt: nullableDate(check.completed_at),
        observedAt: input.observedAt,
      })
    }

    if (pageItems.length < pageSize) {
      checkRunsComplete = true
      break
    }
  }

  if (!checkRunsComplete) {
    throw incompletePaginationError(`check runs for ${input.sourceSha}`)
  }

  let statusesComplete = false

  for (let page = 1; page <= maximumPages; page += 1) {
    const response = await input.client.request(
      'GET /repos/{owner}/{repo}/commits/{ref}/statuses',
      {
        owner: input.metadata.ownerLogin,
        repo: input.metadata.name,
        ref: input.sourceSha,
        per_page: pageSize,
        page,
      },
    )
    const pageItems = requireArray(response.data, 'commit statuses response')

    for (const item of pageItems) {
      const status = requireRecord(item, 'commit status')
      const state = requireString(status.state, 'commit status state')
      results.push({
        commitSha: input.sourceSha,
        type: 'commit_status',
        context: requireString(status.context, 'commit status context'),
        integrationId: null,
        githubObjectId: requirePositiveInteger(status.id, 'commit status ID'),
        attempt: null,
        status: state === 'pending' ? 'pending' : 'completed',
        conclusion:
          state === 'success'
            ? 'success'
            : state === 'failure'
              ? 'failure'
              : state === 'error'
                ? 'error'
                : null,
        detailsUrl: nullableString(status.target_url),
        startedAt: null,
        completedAt: state === 'pending' ? null : nullableDate(status.updated_at),
        observedAt: input.observedAt,
      })
    }

    if (pageItems.length < pageSize) {
      statusesComplete = true
      break
    }
  }

  if (!statusesComplete) {
    throw incompletePaginationError(`commit statuses for ${input.sourceSha}`)
  }

  return deduplicateCheckResults(results)
}

function deduplicateCheckResults(
  results: readonly CommitCheckResultProjection[],
): readonly CommitCheckResultProjection[] {
  const seen = new Set<string>()
  const deduplicated: CommitCheckResultProjection[] = []

  for (const result of results) {
    const key = [result.type, result.githubObjectId, result.attempt ?? ''].join(':')

    if (!seen.has(key)) {
      seen.add(key)
      deduplicated.push(result)
    }
  }

  return deduplicated
}

function addRequiredCheck(
  target: Map<string, RequiredCheckProjection>,
  check: RequiredCheckProjection,
): void {
  const key = [check.type, check.context, check.integrationId ?? ''].join(':')
  target.set(key, check)
}

function normalizeCheckRunStatus(
  value: unknown,
): 'queued' | 'in_progress' | 'pending' | 'completed' {
  switch (value) {
    case 'queued':
    case 'requested':
    case 'waiting':
      return 'queued'

    case 'in_progress':
      return 'in_progress'

    case 'pending':
      return 'pending'

    case 'completed':
      return 'completed'

    default:
      throw new Error(`Unsupported GitHub check run status: ${String(value)}`)
  }
}

function normalizeCheckConclusion(value: unknown): CommitCheckResultProjection['conclusion'] {
  const accepted = new Set([
    'success',
    'failure',
    'neutral',
    'cancelled',
    'skipped',
    'timed_out',
    'action_required',
    'stale',
    'startup_failure',
    'error',
  ])

  return typeof value === 'string' && accepted.has(value)
    ? (value as Exclude<CommitCheckResultProjection['conclusion'], null>)
    : null
}

function incompletePaginationError(resource: string): ProjectConfigurationValidationError {
  return new ProjectConfigurationValidationError(
    'external_state_unknown',
    `GitHub pagination limit was exceeded while loading ${resource}`,
    { details: { maximumPages, pageSize } },
  )
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} is not an object`)
  }

  return value
}

function requireArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} is not an array`)
  }

  return value
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is missing`)
  }

  return value
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} is invalid`)
  }

  return value
}

function nullablePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function requireSha(value: unknown, name: string): string {
  const sha = requireString(value, name).toLowerCase()

  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`${name} is invalid`)
  }

  return sha
}

function nullableDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function getStatus(value: unknown): number | undefined {
  return isRecord(value) && typeof value.status === 'number' ? value.status : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
