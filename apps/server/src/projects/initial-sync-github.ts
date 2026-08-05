import { createHash } from 'node:crypto'

import type { InstallationGitHubClient, InstallationPermissions } from '@shipgate/github'
import { ProjectConfigurationValidationError } from './errors.js'
import type { GitRepositorySnapshot } from './git-workspace.js'
import type {
  RepositoryBranchProjection,
  RepositoryCommitProjection,
  RepositoryProjectionSnapshot,
} from './model.js'
import { attributePullRequestChanges } from './pr-attribution.js'
import {
  loadCheckResultsForCommit,
  loadEffectiveRequiredChecks,
  type RequiredCheckOverride,
} from './required-checks.js'

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
  readonly requiredCheckOverrides: readonly RequiredCheckOverride[]
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
  const requiredChecks = await loadEffectiveRequiredChecks({
    client: input.client,
    repository: input.metadata,
    sourceBranch: input.target.sourceBranch,
    overrides: input.requiredCheckOverrides,
  })
  const targetShas = [
    ...new Set(
      attribution.changes
        .filter((change) => change.productionPresence !== 'released')
        .map((change) => change.finalHeadSha),
    ),
  ]
  const checkResults = (
    await Promise.all(
      targetShas.map((commitSha) =>
        loadCheckResultsForCommit({
          client: input.client,
          repository: input.metadata,
          commitSha,
          observedAt: input.observedAt,
        }),
      ),
    )
  ).flat()

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

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} is not an object`)
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

function requireSha(value: unknown, name: string): string {
  const sha = requireString(value, name).toLowerCase()

  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`${name} is invalid`)
  }

  return sha
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function getStatus(value: unknown): number | undefined {
  return isRecord(value) && typeof value.status === 'number' ? value.status : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
