import type { DatabaseClient } from '@shipgate/database'
import type {
  GitHubAuthenticationService,
  GitHubResponse,
  UserGitHubClient,
} from '@shipgate/github'
import {
  ManagedDependencyBlockError,
  synchronizeManagedDependencyBlock,
} from './dependency-managed-block.js'
import {
  type ChangeDependencyState,
  type DependencyMutationResult,
  DependencyValidationError,
  listChangeDependencies,
  persistPreparedDependencyMutation,
  prepareRemoveDependency,
  prepareSetDependencies,
  type RemoveDependency,
  type SetDependencies,
} from './dependency-workflow.js'
import { ChangeNotFoundError, ProjectNotFoundError } from './errors.js'
import {
  type RepositoryTransaction,
  withRepositoryLock,
  withRepositoryTransactionInLock,
} from './repository-transaction.js'
import { getProject } from './store.js'

export type DependencyAuthorizationCode = 'permission_missing' | 'external_state_unknown'

export class DependencyAuthorizationError extends Error {
  readonly code: DependencyAuthorizationCode

  constructor(
    code: DependencyAuthorizationCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DependencyAuthorizationError'
    this.code = code
  }
}

export class DependencySynchronizationError extends Error {
  readonly rollbackFailed: boolean

  constructor(
    message: string,
    options: { readonly cause: unknown; readonly rollbackFailed?: boolean },
  ) {
    super(message, { cause: options.cause })
    this.name = 'DependencySynchronizationError'
    this.rollbackFailed = options.rollbackFailed ?? false
  }
}

export interface DependencyMutationWithMirrorResult extends DependencyMutationResult {
  readonly githubBodyUpdated: boolean
}

export interface DependencyService {
  list(input: {
    readonly actorGitHubUserId: number
    readonly projectId: string
    readonly changeId: string
  }): Promise<readonly ChangeDependencyState[]>

  set(
    command: Omit<SetDependencies, 'source' | 'actorGitHubUserId'> & {
      readonly actorGitHubUserId: number
    },
  ): Promise<DependencyMutationWithMirrorResult>

  remove(command: RemoveDependency): Promise<DependencyMutationWithMirrorResult>
}

export function createDependencyService(options: {
  readonly database: DatabaseClient
  readonly githubAuth: GitHubAuthenticationService
}): DependencyService {
  return {
    async list(input) {
      const context = await loadMutationContext(options, input.actorGitHubUserId, input.projectId)
      await assertLiveRepositoryPermission(context.client, context.repository, 'read')

      const change = await options.database.kysely
        .selectFrom('changes')
        .select('id')
        .where('project_id', '=', input.projectId)
        .where('repository_id', '=', context.repositoryId)
        .where('id', '=', input.changeId)
        .executeTakeFirst()

      if (!change) {
        throw new ChangeNotFoundError(input.projectId, input.changeId)
      }

      return listChangeDependencies(options.database, input.projectId, input.changeId)
    },

    async set(command) {
      const context = await loadMutationContext(
        options,
        command.actorGitHubUserId,
        command.projectId,
      )
      await assertLiveRepositoryPermission(context.client, context.repository, 'triage')

      const workflowCommand: SetDependencies = {
        ...command,
        source: 'user',
      }

      return mutateWithGitHubMirror(options.database, context, async (scope) => {
        const plan = await prepareSetDependencies(scope, workflowCommand, 'set')
        return { plan, command: workflowCommand }
      })
    },

    async remove(command) {
      const context = await loadMutationContext(
        options,
        command.actorGitHubUserId,
        command.projectId,
      )
      await assertLiveRepositoryPermission(context.client, context.repository, 'triage')

      return mutateWithGitHubMirror(options.database, context, async (scope) => {
        const plan = await prepareRemoveDependency(scope, command)
        const workflowCommand: SetDependencies = {
          actorGitHubUserId: command.actorGitHubUserId,
          projectId: command.projectId,
          changeId: command.changeId,
          dependencyChangeIds: plan.desiredDependencies.map((dependency) => dependency.changeId),
          source: 'user',
          correlationId: command.correlationId,
          ...(command.now === undefined ? {} : { now: command.now }),
        }
        return { plan, command: workflowCommand }
      })
    },
  }
}

async function mutateWithGitHubMirror(
  database: DatabaseClient,
  context: MutationContext,
  prepare: (scope: RepositoryTransaction) => Promise<{
    readonly plan: Awaited<ReturnType<typeof prepareSetDependencies>>
    readonly command: SetDependencies
  }>,
): Promise<DependencyMutationWithMirrorResult> {
  return withRepositoryLock(database, context.repositoryIdNumber, async (lock) => {
    const prepared = await withRepositoryTransactionInLock(lock, prepare)
    const current = await getPullRequestBody(
      context.client,
      context.repository,
      prepared.plan.dependentPullRequestNumber,
    )
    const normalizedCurrentBody = current.body ?? ''
    let desiredBody: string

    try {
      desiredBody = synchronizeManagedDependencyBlock(
        current.body,
        prepared.plan.desiredDependencies.map((dependency) => dependency.pullRequestNumber),
      )
    } catch (error) {
      if (error instanceof ManagedDependencyBlockError) {
        throw new DependencyValidationError('invalid_dependency_block', error.message, {
          cause: error,
          details: { code: error.code },
        })
      }

      throw error
    }

    const githubBodyUpdated = desiredBody !== normalizedCurrentBody
    let githubChanged = false

    try {
      if (githubBodyUpdated) {
        const updated = await updatePullRequestBody(
          context.client,
          context.repository,
          prepared.plan.dependentPullRequestNumber,
          desiredBody,
        )
        githubChanged = true

        if ((updated.body ?? '') !== desiredBody) {
          throw new DependencySynchronizationError(
            'GitHub did not persist the dependency managed block byte-for-byte',
            { cause: new Error('GitHub returned a different pull request body') },
          )
        }
      }

      const persisted = await withRepositoryTransactionInLock(lock, (scope) =>
        persistPreparedDependencyMutation(scope, prepared.command, prepared.plan),
      )

      return { ...persisted, githubBodyUpdated }
    } catch (error) {
      if (githubChanged) {
        try {
          await updatePullRequestBody(
            context.client,
            context.repository,
            prepared.plan.dependentPullRequestNumber,
            current.body,
          )
        } catch (rollbackError) {
          throw new DependencySynchronizationError(
            'Local dependency persistence failed after GitHub changed, and GitHub rollback also failed',
            {
              cause: new AggregateError(
                [error, rollbackError],
                'Dependency mutation and rollback failed',
              ),
              rollbackFailed: true,
            },
          )
        }
      }

      throw error
    }
  })
}

interface RepositoryLocator {
  readonly owner: string
  readonly repo: string
}

interface MutationContext {
  readonly client: UserGitHubClient
  readonly repository: RepositoryLocator
  readonly repositoryId: string
  readonly repositoryIdNumber: number
}

async function loadMutationContext(
  options: { readonly database: DatabaseClient; readonly githubAuth: GitHubAuthenticationService },
  actorGitHubUserId: number,
  projectId: string,
): Promise<MutationContext> {
  const project = await getProject(options.database, projectId)

  if (!project || project.status === 'deleted') {
    throw new ProjectNotFoundError(projectId)
  }

  const repository = parseRepositoryFullName(project.repositoryFullName)
  const repositoryIdNumber = parseStoredGitHubId(project.repositoryId, 'repository ID')
  let client: UserGitHubClient

  try {
    client = await options.githubAuth.getUserClient(actorGitHubUserId)
  } catch (cause) {
    throw new DependencyAuthorizationError(
      'external_state_unknown',
      'The GitHub user access token could not be loaded',
      { cause },
    )
  }

  return {
    client,
    repository,
    repositoryId: project.repositoryId,
    repositoryIdNumber,
  }
}

async function assertLiveRepositoryPermission(
  client: UserGitHubClient,
  repository: RepositoryLocator,
  required: 'read' | 'triage',
): Promise<void> {
  let response: GitHubResponse<unknown>

  try {
    response = await client.request('GET /repos/{owner}/{repo}', { ...repository })
  } catch (cause) {
    throw new DependencyAuthorizationError(
      'external_state_unknown',
      'Current GitHub repository access could not be verified',
      { cause },
    )
  }

  const data = asRecord(response.data)
  const permissions = asRecord(data?.permissions)
  const roleName = typeof data?.role_name === 'string' ? data.role_name : null
  const allowed =
    required === 'read'
      ? hasBooleanPermission(permissions, ['pull', 'triage', 'push', 'maintain', 'admin']) ||
        roleAtLeast(roleName, 'read')
      : hasBooleanPermission(permissions, ['triage', 'push', 'maintain', 'admin']) ||
        roleAtLeast(roleName, 'triage')

  if (!allowed) {
    throw new DependencyAuthorizationError(
      'permission_missing',
      required === 'triage'
        ? 'GitHub Triage or higher repository permission is required'
        : 'GitHub repository read permission is required',
    )
  }
}

async function getPullRequestBody(
  client: UserGitHubClient,
  repository: RepositoryLocator,
  pullRequestNumber: number,
): Promise<{ readonly body: string | null }> {
  try {
    const response = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      ...repository,
      pull_number: pullRequestNumber,
    })
    const data = asRecord(response.data)
    const body = data?.body

    if (typeof body !== 'string' && body !== null) {
      throw new Error('GitHub pull request response does not contain a valid body')
    }

    return { body }
  } catch (cause) {
    throw new DependencySynchronizationError('GitHub pull request body could not be loaded', {
      cause,
    })
  }
}

async function updatePullRequestBody(
  client: UserGitHubClient,
  repository: RepositoryLocator,
  pullRequestNumber: number,
  body: string | null,
): Promise<{ readonly body: string | null }> {
  try {
    const response = await client.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
      ...repository,
      pull_number: pullRequestNumber,
      body,
    })
    const data = asRecord(response.data)
    const updatedBody = data?.body

    if (typeof updatedBody !== 'string' && updatedBody !== null) {
      throw new Error('GitHub pull request update response does not contain a valid body')
    }

    return { body: updatedBody }
  } catch (cause) {
    if (cause instanceof DependencySynchronizationError) {
      throw cause
    }

    throw new DependencySynchronizationError('GitHub pull request body update failed', { cause })
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

function hasBooleanPermission(
  permissions: Readonly<Record<string, unknown>> | null,
  names: readonly string[],
): boolean {
  return names.some((name) => permissions?.[name] === true)
}

function roleAtLeast(value: string | null, required: 'read' | 'triage'): boolean {
  if (!value) {
    return false
  }

  const levels = ['none', 'read', 'triage', 'write', 'maintain', 'admin'] as const
  const actualIndex = levels.indexOf(value as (typeof levels)[number])
  const requiredIndex = levels.indexOf(required)
  return actualIndex >= requiredIndex
}

function parseRepositoryFullName(value: string): RepositoryLocator {
  const separator = value.indexOf('/')

  if (
    separator <= 0 ||
    separator === value.length - 1 ||
    value.indexOf('/', separator + 1) !== -1
  ) {
    throw new Error(`Stored repository full name is invalid: ${value}`)
  }

  return { owner: value.slice(0, separator), repo: value.slice(separator + 1) }
}

function parseStoredGitHubId(value: string, name: string): number {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Stored GitHub ${name} is outside the safe integer range: ${value}`)
  }

  return parsed
}
