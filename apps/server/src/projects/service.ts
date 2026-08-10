import type { DatabaseClient } from '@shipgate/database'
import {
  GITHUB_APP_REPOSITORY_PERMISSIONS,
  type InstallationPermissionLevel,
} from '@shipgate/github'

import {
  type GitHubRepositoryAccessService,
  GitHubRepositoryAccessVerificationError,
  type RepositoryAccessDecision,
} from '../github-access/index.js'
import {
  type ConfigureProjectResult,
  createConfiguredProject,
  listStoredProjects,
  requestProjectDeletion,
  updateConfiguredProject,
  updateProjectRequiredCheckOverrides,
} from './configuration-store.js'
import {
  loadProjectOverview,
  loadProjectSynchronizationHistory,
  type ProjectOverview,
  type ProjectSynchronizationHistory,
} from './dashboard.js'
import {
  ProjectConfigurationValidationError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
  RepositoryAlreadyConnectedError,
} from './errors.js'
import type {
  ChangeAheadOfProduction,
  ProjectRecord,
  ReconciliationRequestRecord,
  RequiredCheckOverride,
} from './model.js'
import { withRepositoryTransaction } from './repository-transaction.js'
import { normalizeRequiredCheckOverrides } from './required-checks.js'
import { getProject, listChangesAheadOfProduction } from './store.js'
import { queueRepositoryReconciliationForProject } from './sync-queue.js'
import type { ProjectTopologyValidator } from './topology.js'

export interface ProjectService {
  create(input: {
    readonly actorGitHubUserId: number
    readonly installationId: number
    readonly repositoryId: number
    readonly sourceBranch: string
    readonly productionBranch: string
    readonly requiredCheckOverrides?: readonly RequiredCheckOverride[]
    readonly correlationId: string
  }): Promise<ConfigureProjectResult>

  list(actorGitHubUserId: number): Promise<readonly ProjectRecord[]>

  get(actorGitHubUserId: number, projectId: string): Promise<ProjectRecord>

  getOverview(actorGitHubUserId: number, projectId: string): Promise<ProjectOverview>

  getSynchronization(
    actorGitHubUserId: number,
    projectId: string,
    limit?: number,
  ): Promise<ProjectSynchronizationHistory>

  listChanges(
    actorGitHubUserId: number,
    projectId: string,
  ): Promise<readonly ChangeAheadOfProduction[]>

  reconcile(input: {
    readonly actorGitHubUserId: number
    readonly projectId: string
    readonly expectedConfigurationVersion: number
    readonly correlationId: string
  }): Promise<ReconciliationRequestRecord>

  update(input: {
    readonly actorGitHubUserId: number
    readonly projectId: string
    readonly expectedConfigurationVersion: number
    readonly sourceBranch?: string
    readonly productionBranch?: string
    readonly requiredCheckOverrides?: readonly RequiredCheckOverride[]
    readonly correlationId: string
  }): Promise<ConfigureProjectResult>

  delete(input: {
    readonly actorGitHubUserId: number
    readonly projectId: string
    readonly expectedConfigurationVersion: number
  }): Promise<ProjectRecord>
}

export function createProjectService(options: {
  readonly database: DatabaseClient
  readonly githubRepositoryAccess: GitHubRepositoryAccessService
  readonly topologyValidator: ProjectTopologyValidator
}): ProjectService {
  return {
    async create(input) {
      await requireRepositoryPermission(options, {
        githubUserId: input.actorGitHubUserId,
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        permission: 'maintain',
      })
      await assertProjectAppPermissions(options.database, input.installationId)
      const existing = await options.database.kysely
        .selectFrom('projects')
        .select('id')
        .where('repository_id', '=', String(input.repositoryId))
        .where('status', '<>', 'deleted')
        .executeTakeFirst()

      if (existing) {
        throw new RepositoryAlreadyConnectedError(String(input.repositoryId), existing.id)
      }

      const topology = await options.topologyValidator.validate(input)

      return withRepositoryTransaction(options.database, input.repositoryId, async (scope) =>
        createConfiguredProject({
          scope,
          topology,
          actorGitHubUserId: input.actorGitHubUserId,
          correlationId: input.correlationId,
          ...(input.requiredCheckOverrides !== undefined
            ? { requiredCheckOverrides: input.requiredCheckOverrides }
            : {}),
        }),
      )
    },

    async list(actorGitHubUserId) {
      const projects = await listStoredProjects(options.database)
      const visible: ProjectRecord[] = []

      for (const project of projects) {
        const allowed = await canReadProject(options, actorGitHubUserId, project)

        if (allowed) {
          visible.push(project)
        }
      }

      return visible
    },

    async get(actorGitHubUserId, projectId) {
      return requireReadableProject(options, actorGitHubUserId, projectId)
    },

    async getOverview(actorGitHubUserId, projectId) {
      const project = await requireReadableProject(options, actorGitHubUserId, projectId)

      return loadProjectOverview(options.database, project)
    },

    async getSynchronization(actorGitHubUserId, projectId, limit) {
      const project = await requireReadableProject(options, actorGitHubUserId, projectId)

      return loadProjectSynchronizationHistory(options.database, project, limit)
    },

    async listChanges(actorGitHubUserId, projectId) {
      const project = await requireStoredProject(options.database, projectId)

      if (!(await canReadProject(options, actorGitHubUserId, project))) {
        throw new ProjectNotFoundError(projectId)
      }

      return listChangesAheadOfProduction(options.database, project.id)
    },

    async reconcile(input) {
      const project = await requireStoredProject(options.database, input.projectId)
      const installationId = parseGitHubId(project.installationId, 'installation ID')
      const repositoryId = parseGitHubId(project.repositoryId, 'repository ID')

      if (project.configurationVersion !== input.expectedConfigurationVersion) {
        throw new ProjectVersionConflictError(
          project.id,
          input.expectedConfigurationVersion,
          project.configurationVersion,
        )
      }

      await requireRepositoryPermission(options, {
        githubUserId: input.actorGitHubUserId,
        installationId,
        repositoryId,
        permission: 'maintain',
      })
      await assertProjectAppPermissions(options.database, installationId)

      if (!['initializing', 'active', 'degraded', 'disconnected'].includes(project.status)) {
        throw new ProjectConfigurationValidationError(
          'project_not_active',
          `Project ${project.id} is ${project.status} and cannot be reconciled`,
        )
      }

      if (!project.sourceSha || !project.productionSha) {
        throw new ProjectConfigurationValidationError(
          'repository_state_changed',
          'Project branch heads have not been observed yet',
        )
      }

      const reconciliation = await queueRepositoryReconciliationForProject(options.database, {
        projectId: project.id,
        reason: 'manual_reconciliation',
        requestedByGitHubUserId: String(input.actorGitHubUserId),
        deduplicationKey: input.correlationId,
        correlationId: input.correlationId,
        causationId: `http:${input.correlationId}`,
        triggerScope: {
          reasons: ['manual_reconciliation'],
          branchNames: [project.sourceBranch, project.productionBranch],
          requireReconciliation: true,
        },
      })

      if (!reconciliation) {
        throw new ProjectConfigurationValidationError(
          'repository_state_changed',
          'Project changed before reconciliation could be queued',
        )
      }

      return reconciliation
    },

    async update(input) {
      const project = await requireStoredProject(options.database, input.projectId)
      const installationId = parseGitHubId(project.installationId, 'installation ID')
      const repositoryId = parseGitHubId(project.repositoryId, 'repository ID')

      if (project.configurationVersion !== input.expectedConfigurationVersion) {
        throw new ProjectVersionConflictError(
          project.id,
          input.expectedConfigurationVersion,
          project.configurationVersion,
        )
      }

      await requireRepositoryPermission(options, {
        githubUserId: input.actorGitHubUserId,
        installationId,
        repositoryId,
        permission: 'maintain',
      })

      if (!['initializing', 'active', 'degraded'].includes(project.status)) {
        throw new ProjectConfigurationValidationError(
          'project_not_active',
          `Project ${project.id} is ${project.status} and cannot be reconfigured`,
        )
      }

      const sourceBranch = input.sourceBranch ?? project.sourceBranch
      const productionBranch = input.productionBranch ?? project.productionBranch
      const requiredCheckOverrides = normalizeRequiredCheckOverrides(
        input.requiredCheckOverrides ?? project.requiredCheckOverrides,
      )
      const branchesChanged =
        sourceBranch !== project.sourceBranch || productionBranch !== project.productionBranch
      const overridesChanged =
        JSON.stringify(requiredCheckOverrides) !== JSON.stringify(project.requiredCheckOverrides)

      if (!branchesChanged && !overridesChanged) {
        return { status: 'already_applied', project, reconciliation: null }
      }

      await assertProjectAppPermissions(options.database, installationId)

      if (!branchesChanged) {
        return withRepositoryTransaction(options.database, repositoryId, async (scope) =>
          updateProjectRequiredCheckOverrides({
            scope,
            projectId: input.projectId,
            expectedConfigurationVersion: input.expectedConfigurationVersion,
            requiredCheckOverrides,
            actorGitHubUserId: input.actorGitHubUserId,
            correlationId: input.correlationId,
          }),
        )
      }

      const topology = await options.topologyValidator.validate({
        installationId,
        repositoryId,
        sourceBranch,
        productionBranch,
      })

      return withRepositoryTransaction(options.database, repositoryId, async (scope) =>
        updateConfiguredProject({
          scope,
          projectId: input.projectId,
          expectedConfigurationVersion: input.expectedConfigurationVersion,
          topology,
          requiredCheckOverrides,
          actorGitHubUserId: input.actorGitHubUserId,
          correlationId: input.correlationId,
        }),
      )
    },

    async delete(input) {
      const project = await requireStoredProject(options.database, input.projectId)
      const installationId = parseGitHubId(project.installationId, 'installation ID')
      const repositoryId = parseGitHubId(project.repositoryId, 'repository ID')

      if (project.configurationVersion !== input.expectedConfigurationVersion) {
        throw new ProjectVersionConflictError(
          project.id,
          input.expectedConfigurationVersion,
          project.configurationVersion,
        )
      }

      await requireRepositoryPermission(options, {
        githubUserId: input.actorGitHubUserId,
        installationId,
        repositoryId,
        permission: 'maintain',
      })

      return withRepositoryTransaction(options.database, repositoryId, async (scope) =>
        requestProjectDeletion({
          scope,
          projectId: input.projectId,
          expectedConfigurationVersion: input.expectedConfigurationVersion,
          actorGitHubUserId: input.actorGitHubUserId,
        }),
      )
    },
  }
}

async function requireReadableProject(
  options: {
    readonly database: DatabaseClient
    readonly githubRepositoryAccess: GitHubRepositoryAccessService
  },
  githubUserId: number,
  projectId: string,
): Promise<ProjectRecord> {
  const project = await requireStoredProject(options.database, projectId)

  if (!(await canReadProject(options, githubUserId, project))) {
    throw new ProjectNotFoundError(projectId)
  }

  return project
}

async function canReadProject(
  options: {
    readonly database: DatabaseClient
    readonly githubRepositoryAccess: GitHubRepositoryAccessService
  },
  githubUserId: number,
  project: ProjectRecord,
): Promise<boolean> {
  try {
    const decision = await options.githubRepositoryAccess.authorizeRepositoryAccess({
      githubUserId,
      installationId: parseGitHubId(project.installationId, 'installation ID'),
      repositoryId: parseGitHubId(project.repositoryId, 'repository ID'),
      requiredPermission: {
        repository: 'read',
        app: { name: 'metadata', level: 'read' },
      },
    })

    if (decision.allowed) {
      return true
    }

    if (
      decision.reason !== 'installation_suspended' &&
      decision.reason !== 'insufficient_app_permission'
    ) {
      return false
    }

    const localAccess = await options.database.kysely
      .selectFrom('github_user_installation_repositories')
      .select('repository_id')
      .where('github_user_id', '=', String(githubUserId))
      .where('installation_id', '=', project.installationId)
      .where('repository_id', '=', project.repositoryId)
      .executeTakeFirst()

    return localAccess !== undefined
  } catch (cause) {
    throw createAccessVerificationError(cause)
  }
}

async function requireRepositoryPermission(
  options: {
    readonly githubRepositoryAccess: GitHubRepositoryAccessService
  },
  input: {
    readonly githubUserId: number
    readonly installationId: number
    readonly repositoryId: number
    readonly permission: 'read' | 'maintain'
  },
): Promise<void> {
  let decision: RepositoryAccessDecision

  try {
    decision = await options.githubRepositoryAccess.authorizeRepositoryAccess({
      githubUserId: input.githubUserId,
      installationId: input.installationId,
      repositoryId: input.repositoryId,
      requiredPermission: {
        repository: input.permission,
        app: { name: 'metadata', level: 'read' },
      },
    })
  } catch (cause) {
    throw createAccessVerificationError(cause)
  }

  if (decision.allowed) {
    return
  }

  const code =
    decision.reason === 'insufficient_repository_permission'
      ? 'permission_missing'
      : decision.reason === 'insufficient_app_permission'
        ? 'app_permissions_missing'
        : decision.reason.startsWith('installation_')
          ? 'installation_unavailable'
          : 'repository_unavailable'

  throw new ProjectConfigurationValidationError(
    code,
    code === 'permission_missing'
      ? 'GitHub Maintain or Admin repository permission is required'
      : 'GitHub repository access validation failed',
    { details: { reason: decision.reason } },
  )
}

async function assertProjectAppPermissions(
  database: DatabaseClient,
  installationId: number,
): Promise<void> {
  const rows = await database.kysely
    .selectFrom('github_installation_permissions')
    .select(['permission_name', 'permission_level'])
    .where('installation_id', '=', String(installationId))
    .execute()
  const actual = new Map<string, InstallationPermissionLevel>(
    rows.map((row) => [row.permission_name, row.permission_level] as const),
  )
  const missing = Object.entries(GITHUB_APP_REPOSITORY_PERMISSIONS)
    .filter(([name, required]) => !permissionSatisfies(actual.get(name), required))
    .map(([name, required]) => ({ name, required, actual: actual.get(name) ?? null }))

  if (missing.length > 0) {
    throw new ProjectConfigurationValidationError(
      'app_permissions_missing',
      'GitHub App installation does not have all permissions required for repository projection',
      { details: { missing } },
    )
  }
}

function permissionSatisfies(
  actual: InstallationPermissionLevel | undefined,
  required: InstallationPermissionLevel,
): boolean {
  return actual === 'write' || (actual === 'read' && required === 'read')
}

async function requireStoredProject(
  database: DatabaseClient,
  projectId: string,
): Promise<ProjectRecord> {
  const project = await getProject(database, projectId)

  if (!project || project.status === 'deleted') {
    throw new ProjectNotFoundError(projectId)
  }

  return project
}

function parseGitHubId(value: string, name: string): number {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Stored ${name} is outside JavaScript's safe integer range: ${value}`)
  }

  return parsed
}

function createAccessVerificationError(cause: unknown): ProjectConfigurationValidationError {
  return new ProjectConfigurationValidationError(
    'external_state_unknown',
    cause instanceof GitHubRepositoryAccessVerificationError
      ? 'GitHub repository access could not be verified'
      : 'Repository access validation failed unexpectedly',
    { cause },
  )
}
