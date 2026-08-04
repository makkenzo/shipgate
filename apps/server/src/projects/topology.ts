import type {
  GitHubAuthenticationService,
  InstallationGitHubClient,
  InstallationPermissions,
} from '@shipgate/github'

import { ProjectConfigurationValidationError } from './errors.js'
import type { ReadOnlyGitWorkspace } from './git-workspace.js'

const topologyPermissions = {
  metadata: 'read',
  contents: 'read',
} as const satisfies InstallationPermissions

export interface ValidatedProjectTopology {
  readonly installationId: number
  readonly repositoryId: number
  readonly ownerId: number
  readonly ownerLogin: string
  readonly repositoryName: string
  readonly repositoryFullName: string
  readonly cloneUrl: string
  readonly defaultBranch: string | null
  readonly sourceBranch: string
  readonly productionBranch: string
  readonly sourceSha: string
  readonly productionSha: string
  readonly compareStatus: 'ahead' | 'identical'
}

export interface ProjectTopologyValidator {
  validate(input: {
    readonly installationId: number
    readonly repositoryId: number
    readonly sourceBranch: string
    readonly productionBranch: string
  }): Promise<ValidatedProjectTopology>
}

export function createProjectTopologyValidator(options: {
  readonly githubAuth: GitHubAuthenticationService
  readonly gitWorkspace: ReadOnlyGitWorkspace
}): ProjectTopologyValidator {
  return {
    async validate(input) {
      assertPositiveGitHubId(input.installationId, 'installationId')
      assertPositiveGitHubId(input.repositoryId, 'repositoryId')
      const sourceBranch = assertBranch(input.sourceBranch, 'source branch')
      const productionBranch = assertBranch(input.productionBranch, 'production branch')

      if (sourceBranch === productionBranch) {
        throw new ProjectConfigurationValidationError(
          'source_equals_production',
          'Source and production branches must differ',
        )
      }

      let client: InstallationGitHubClient

      try {
        client = await options.githubAuth.getInstallationClient({
          installationId: input.installationId,
          repositoryIds: [input.repositoryId],
          permissions: topologyPermissions,
        })
      } catch (cause) {
        throw new ProjectConfigurationValidationError(
          'installation_unavailable',
          'GitHub installation cannot issue a repository-scoped token',
          { cause },
        )
      }

      const repository = await loadRepository(client, input.repositoryId)
      const [sourceRef, productionRef] = await Promise.all([
        loadCommitRef(client, repository, sourceBranch, 'source'),
        loadCommitRef(client, repository, productionBranch, 'production'),
      ])
      const compareStatus = await compareBranches(
        client,
        repository,
        productionRef.sha,
        sourceRef.sha,
      )
      if (!options.githubAuth.withInstallationToken) {
        throw new ProjectConfigurationValidationError(
          'external_state_unknown',
          'GitHub authentication provider cannot lease an installation token for Git verification',
        )
      }

      await options.githubAuth.withInstallationToken(
        {
          installationId: input.installationId,
          repositoryIds: [input.repositoryId],
          permissions: topologyPermissions,
        },
        async ({ token }) =>
          options.gitWorkspace.assertProductionAncestor({
            cloneUrl: repository.cloneUrl,
            installationToken: token,
            sourceBranch,
            productionBranch,
            sourceSha: sourceRef.sha,
            productionSha: productionRef.sha,
          }),
      )

      return {
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        ownerId: repository.ownerId,
        ownerLogin: repository.ownerLogin,
        repositoryName: repository.name,
        repositoryFullName: repository.fullName,
        cloneUrl: repository.cloneUrl,
        defaultBranch: repository.defaultBranch,
        sourceBranch,
        productionBranch,
        sourceSha: sourceRef.sha,
        productionSha: productionRef.sha,
        compareStatus,
      }
    },
  }
}

interface RepositoryIdentity {
  readonly id: number
  readonly ownerId: number
  readonly ownerLogin: string
  readonly name: string
  readonly fullName: string
  readonly cloneUrl: string
  readonly defaultBranch: string | null
}

async function loadRepository(
  client: InstallationGitHubClient,
  expectedRepositoryId: number,
): Promise<RepositoryIdentity> {
  let response: Awaited<ReturnType<InstallationGitHubClient['request']>>

  try {
    response = await client.request('GET /repositories/{repository_id}', {
      repository_id: expectedRepositoryId,
    })
  } catch (cause) {
    throw new ProjectConfigurationValidationError(
      getGitHubErrorStatus(cause) === 404 ? 'repository_unavailable' : 'external_state_unknown',
      'GitHub repository is unavailable to the installation',
      { cause },
    )
  }

  const value = requireRecord(response.data, 'GitHub repository response')
  const owner = requireRecord(value.owner, 'GitHub repository owner')
  const id = requirePositiveInteger(value.id, 'repository ID')

  if (id !== expectedRepositoryId) {
    throw new ProjectConfigurationValidationError(
      'repository_state_changed',
      'GitHub returned a different repository identity',
      { details: { expectedRepositoryId, actualRepositoryId: id } },
    )
  }

  if (value.archived === true || value.disabled === true) {
    throw new ProjectConfigurationValidationError(
      'repository_unavailable',
      value.archived === true ? 'GitHub repository is archived' : 'GitHub repository is disabled',
    )
  }

  return {
    id,
    ownerId: requirePositiveInteger(owner.id, 'repository owner ID'),
    ownerLogin: requireString(owner.login, 'repository owner login'),
    name: requireString(value.name, 'repository name'),
    fullName: requireString(value.full_name, 'repository full name'),
    cloneUrl: requireString(value.clone_url, 'repository clone URL'),
    defaultBranch: nullableString(value.default_branch),
  }
}

async function loadCommitRef(
  client: InstallationGitHubClient,
  repository: RepositoryIdentity,
  branch: string,
  role: 'source' | 'production',
): Promise<{ readonly sha: string }> {
  let response: Awaited<ReturnType<InstallationGitHubClient['request']>>

  try {
    response = await client.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
      owner: repository.ownerLogin,
      repo: repository.name,
      ref: `heads/${branch}`,
    })
  } catch (cause) {
    const status = getGitHubErrorStatus(cause)

    throw new ProjectConfigurationValidationError(
      status === 404
        ? role === 'source'
          ? 'source_branch_missing'
          : 'production_branch_missing'
        : 'external_state_unknown',
      `${capitalize(role)} branch ref could not be resolved`,
      { cause, details: { branch, status } },
    )
  }

  const value = requireRecord(response.data, `${role} ref response`)
  const object = requireRecord(value.object, `${role} ref object`)
  const expectedRef = `refs/heads/${branch}`

  if (value.ref !== expectedRef) {
    throw new ProjectConfigurationValidationError(
      'repository_state_changed',
      `${capitalize(role)} branch resolved to an unexpected ref`,
      { details: { expectedRef, actualRef: value.ref } },
    )
  }

  if (object.type !== 'commit') {
    throw new ProjectConfigurationValidationError(
      role === 'source' ? 'source_ref_not_commit' : 'production_ref_not_commit',
      `${capitalize(role)} branch ref does not point directly to a commit`,
      { details: { branch, objectType: object.type } },
    )
  }

  const sha = requireString(object.sha, `${role} commit SHA`).toLowerCase()

  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new ProjectConfigurationValidationError(
      role === 'source' ? 'source_ref_not_commit' : 'production_ref_not_commit',
      `${capitalize(role)} branch contains an invalid commit SHA`,
      { details: { branch } },
    )
  }

  return { sha }
}

async function compareBranches(
  client: InstallationGitHubClient,
  repository: RepositoryIdentity,
  productionSha: string,
  sourceSha: string,
): Promise<'ahead' | 'identical'> {
  let response: Awaited<ReturnType<InstallationGitHubClient['request']>>

  try {
    response = await client.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
      owner: repository.ownerLogin,
      repo: repository.name,
      basehead: `${productionSha}...${sourceSha}`,
    })
  } catch (cause) {
    const status = getGitHubErrorStatus(cause)

    throw new ProjectConfigurationValidationError(
      status === 404 ? 'production_branch_not_ancestor' : 'external_state_unknown',
      status === 404
        ? 'Production and source branches do not have a comparable ancestor'
        : 'GitHub Compare API could not verify release topology',
      { cause, details: { status } },
    )
  }

  const value = requireRecord(response.data, 'GitHub compare response')
  const status = value.status

  if (status === 'ahead' || status === 'identical') {
    return status
  }

  if (status === 'behind' || status === 'diverged') {
    throw new ProjectConfigurationValidationError(
      'production_branch_not_ancestor',
      'Production branch is not an ancestor of source branch',
      { details: { compareStatus: status, productionSha, sourceSha } },
    )
  }

  throw new ProjectConfigurationValidationError(
    'external_state_unknown',
    'GitHub Compare API returned an unsupported status',
    { details: { compareStatus: status } },
  )
}

function assertBranch(value: string, name: string): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 255 ||
    value.includes('\r') ||
    value.includes('\n') ||
    value.includes('\0')
  ) {
    throw new ProjectConfigurationValidationError('invalid_branch_name', `${name} is invalid`)
  }

  return value
}

function assertPositiveGitHubId(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
}

function requireRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectConfigurationValidationError('external_state_unknown', `${name} is invalid`)
  }

  return value as Readonly<Record<string, unknown>>
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProjectConfigurationValidationError('external_state_unknown', `${name} is invalid`)
  }

  return value
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProjectConfigurationValidationError('external_state_unknown', `${name} is invalid`)
  }

  return value
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function getGitHubErrorStatus(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    return undefined
  }

  const status = Reflect.get(value, 'status')

  return typeof status === 'number' ? status : undefined
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}
