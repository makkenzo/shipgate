import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'
import { DatabaseOperationError } from '@shipgate/database'

import type { ApplicationContext } from '../../application-context.js'
import type { AuthenticatedSession } from '../../auth/model.js'
import {
  type ConfigureProjectResult,
  ProjectConfigurationValidationError,
  type ProjectHealth,
  ProjectNotFoundError,
  type ProjectRecord,
  type ProjectSynchronizationSummary,
  ProjectVersionConflictError,
  type ReconciliationRequestRecord,
  RepositoryAlreadyConnectedError,
} from '../../projects/index.js'
import { ApiHttpError } from '../api-error.js'
import { CsrfHeadersSchema } from '../auth-schemas.js'
import {
  ProjectOverviewSchema,
  ProjectReconcileBodySchema,
  ProjectReconcileResponseSchema,
  ProjectSynchronizationQuerySchema,
  ProjectSynchronizationSchema,
} from '../project-dashboard-schemas.js'
import {
  CreateProjectBodySchema,
  DeleteProjectQuerySchema,
  ProjectChangesSchema,
  ProjectListSchema,
  ProjectMutationResponseSchema,
  ProjectParamsSchema,
  ProjectSchema,
  UpdateProjectBodySchema,
} from '../project-schemas.js'
import { ApiErrorSchema } from '../schemas.js'
import { requireAuthenticatedSession, requireCsrfProtection } from '../session-middleware.js'

export const projectRoutes: FastifyPluginAsyncTypebox<{
  readonly context: ApplicationContext
}> = async (app, { context }) => {
  app.post(
    '/projects',
    {
      preHandler: [requireAuthenticatedSession, requireCsrfProtection],
      schema: {
        operationId: 'createProject',
        summary: 'Create a Shipgate project from a GitHub repository',
        tags: ['Projects'],
        security: [{ shipgateSession: [] }],
        headers: CsrfHeadersSchema,
        body: CreateProjectBodySchema,
        response: { 201: ProjectMutationResponseSchema, default: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const session = requireSession(request.shipgateSession)

      try {
        const result = await context.projects.create({
          actorGitHubUserId: session.githubUserId,
          correlationId: request.id,
          ...request.body,
        })

        return reply.code(201).send(mapMutationResult(result))
      } catch (error) {
        throw mapProjectError(error)
      }
    },
  )

  app.get(
    '/projects',
    {
      preHandler: [requireAuthenticatedSession],
      schema: {
        operationId: 'getProjects',
        summary: 'List projects visible to the current user',
        tags: ['Projects'],
        security: [{ shipgateSession: [] }],
        response: { 200: ProjectListSchema, default: ApiErrorSchema },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)

      try {
        return {
          projects: (await context.projects.list(session.githubUserId)).map(mapProject),
        }
      } catch (error) {
        throw mapProjectError(error)
      }
    },
  )

  app.get(
    '/projects/:projectId',
    {
      preHandler: [requireAuthenticatedSession],
      schema: {
        operationId: 'getProject',
        summary: 'Get a Shipgate project',
        tags: ['Projects'],
        security: [{ shipgateSession: [] }],
        params: ProjectParamsSchema,
        response: { 200: ProjectSchema, default: ApiErrorSchema },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)

      try {
        return mapProject(
          await context.projects.get(session.githubUserId, request.params.projectId),
        )
      } catch (error) {
        throw mapProjectError(error)
      }
    },
  )

  app.get(
    '/projects/:projectId/overview',
    {
      preHandler: [requireAuthenticatedSession],
      schema: {
        operationId: 'getProjectOverview',
        summary: 'Get the repository dashboard projection for a project',
        tags: ['Projects'],
        security: [{ shipgateSession: [] }],
        params: ProjectParamsSchema,
        response: { 200: ProjectOverviewSchema, default: ApiErrorSchema },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)

      try {
        return mapOverview(
          await context.projects.getOverview(session.githubUserId, request.params.projectId),
        )
      } catch (error) {
        throw mapProjectError(error)
      }
    },
  )

  app.get(
    '/projects/:projectId/synchronization',
    {
      preHandler: [requireAuthenticatedSession],
      schema: {
        operationId: 'getProjectSynchronization',
        summary: 'Get repository synchronization history and detected issues',
        tags: ['Projects'],
        security: [{ shipgateSession: [] }],
        params: ProjectParamsSchema,
        querystring: ProjectSynchronizationQuerySchema,
        response: { 200: ProjectSynchronizationSchema, default: ApiErrorSchema },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)

      try {
        return mapSynchronizationHistory(
          await context.projects.getSynchronization(
            session.githubUserId,
            request.params.projectId,
            request.query.limit,
          ),
        )
      } catch (error) {
        throw mapProjectError(error)
      }
    },
  )

  app.post(
    '/projects/:projectId/reconciliation',
    {
      preHandler: [requireAuthenticatedSession, requireCsrfProtection],
      schema: {
        operationId: 'reconcileProject',
        summary: 'Queue an authoritative repository reconciliation',
        tags: ['Projects'],
        security: [{ shipgateSession: [] }],
        headers: CsrfHeadersSchema,
        params: ProjectParamsSchema,
        body: ProjectReconcileBodySchema,
        response: { 202: ProjectReconcileResponseSchema, default: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const session = requireSession(request.shipgateSession)

      try {
        const reconciliation = await context.projects.reconcile({
          actorGitHubUserId: session.githubUserId,
          projectId: request.params.projectId,
          expectedConfigurationVersion: request.body.expectedConfigurationVersion,
          correlationId: request.id,
        })

        return reply.code(202).send({ reconciliation: mapReconciliation(reconciliation) })
      } catch (error) {
        throw mapProjectError(error)
      }
    },
  )

  app.get(
    '/projects/:projectId/changes',
    {
      preHandler: [requireAuthenticatedSession],
      schema: {
        operationId: 'getProjectChanges',
        summary: 'List unreleased changes with required-check states',
        tags: ['Projects'],
        security: [{ shipgateSession: [] }],
        params: ProjectParamsSchema,
        response: { 200: ProjectChangesSchema, default: ApiErrorSchema },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)

      try {
        const changes = await context.projects.listChanges(
          session.githubUserId,
          request.params.projectId,
        )

        return { changes: changes.map(mapChange) }
      } catch (error) {
        throw mapProjectError(error)
      }
    },
  )

  app.patch(
    '/projects/:projectId',
    {
      preHandler: [requireAuthenticatedSession, requireCsrfProtection],
      schema: {
        operationId: 'updateProject',
        summary: 'Change project branches or required-check overrides',
        tags: ['Projects'],
        security: [{ shipgateSession: [] }],
        headers: CsrfHeadersSchema,
        params: ProjectParamsSchema,
        body: UpdateProjectBodySchema,
        response: {
          200: ProjectMutationResponseSchema,
          202: ProjectMutationResponseSchema,
          default: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const session = requireSession(request.shipgateSession)

      try {
        const result = await context.projects.update({
          actorGitHubUserId: session.githubUserId,
          projectId: request.params.projectId,
          expectedConfigurationVersion: request.body.expectedConfigurationVersion,
          correlationId: request.id,
          ...(request.body.sourceBranch !== undefined
            ? { sourceBranch: request.body.sourceBranch }
            : {}),
          ...(request.body.productionBranch !== undefined
            ? { productionBranch: request.body.productionBranch }
            : {}),
          ...(request.body.requiredCheckOverrides !== undefined
            ? { requiredCheckOverrides: request.body.requiredCheckOverrides }
            : {}),
        })
        const code = result.status === 'already_applied' ? 200 : 202

        return reply.code(code).send(mapMutationResult(result))
      } catch (error) {
        throw mapProjectError(error)
      }
    },
  )

  app.delete(
    '/projects/:projectId',
    {
      preHandler: [requireAuthenticatedSession, requireCsrfProtection],
      schema: {
        operationId: 'deleteProject',
        summary: 'Request deletion of a Shipgate project',
        tags: ['Projects'],
        security: [{ shipgateSession: [] }],
        headers: CsrfHeadersSchema,
        params: ProjectParamsSchema,
        querystring: DeleteProjectQuerySchema,
        response: {
          202: Type.Object(
            { status: Type.Literal('pending_deletion'), project: ProjectSchema },
            { additionalProperties: false },
          ),
          default: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const session = requireSession(request.shipgateSession)

      try {
        const project = await context.projects.delete({
          actorGitHubUserId: session.githubUserId,
          projectId: request.params.projectId,
          expectedConfigurationVersion: request.query.expectedConfigurationVersion,
        })

        return reply
          .code(202)
          .send({ status: 'pending_deletion' as const, project: mapProject(project) })
      } catch (error) {
        throw mapProjectError(error)
      }
    },
  )
}

function mapMutationResult(result: ConfigureProjectResult) {
  return {
    status: result.status,
    project: mapProject(result.project),
    reconciliation: mapReconciliation(result.reconciliation),
  }
}

function mapProject(project: ProjectRecord) {
  return {
    id: project.id,
    installationId: parseSafeId(project.installationId, 'installation ID'),
    repositoryId: parseSafeId(project.repositoryId, 'repository ID'),
    repository: {
      ownerId: parseSafeId(project.ownerId, 'repository owner ID'),
      ownerLogin: project.ownerLogin,
      name: project.repositoryName,
      fullName: project.repositoryFullName,
      defaultBranch: project.defaultBranch,
    },
    sourceBranch: project.sourceBranch,
    productionBranch: project.productionBranch,
    status: project.status,
    sourceSha: project.sourceSha,
    productionSha: project.productionSha,
    lastSuccessfulSynchronization: project.lastSuccessfulSyncAt?.toISOString() ?? null,
    configurationVersion: project.configurationVersion,
    requiredCheckPolicyVersion: project.requiredCheckPolicyVersion,
    requiredCheckOverrides: project.requiredCheckOverrides.map((override) => ({
      context: override.context,
      integrationId: override.integrationId,
    })),
    deletionRequestedAt: project.deletionRequestedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  }
}

function mapChange(
  change: Awaited<ReturnType<ApplicationContext['projects']['listChanges']>>[number],
) {
  return {
    ...change,
    githubPullRequestId: parseSafeId(change.githubPullRequestId, 'pull request ID'),
    authorId: change.authorId === null ? null : parseSafeId(change.authorId, 'author ID'),
    mergedAt: change.mergedAt.toISOString(),
    commitCount: change.commitShas.length,
    commitShas: [...change.commitShas],
    requiredChecks: change.requiredChecks.map((required) => ({
      ...required,
      observedAt: required.observedAt.toISOString(),
      observations: required.observations.map((observation) => ({
        ...observation,
        startedAt: observation.startedAt?.toISOString() ?? null,
        completedAt: observation.completedAt?.toISOString() ?? null,
        observedAt: observation.observedAt.toISOString(),
      })),
    })),
  }
}

function mapOverview(overview: Awaited<ReturnType<ApplicationContext['projects']['getOverview']>>) {
  return {
    project: mapProject(overview.project),
    branches: {
      source: mapOverviewBranch(overview.branches.source),
      production: mapOverviewBranch(overview.branches.production),
    },
    counts: overview.counts,
    requiredChecks: {
      policyVersion: overview.requiredChecks.policyVersion,
      state: overview.requiredChecks.state,
      checks: overview.requiredChecks.checks.map((check) => ({
        ...check,
        stateCounts: { ...check.stateCounts },
      })),
    },
    lastSynchronization:
      overview.lastSynchronization === null
        ? null
        : mapSynchronizationSummary(overview.lastSynchronization),
    health: mapProjectHealth(overview.health),
  }
}

function mapOverviewBranch(
  branch: Awaited<ReturnType<ApplicationContext['projects']['getOverview']>>['branches']['source'],
) {
  return {
    ...branch,
    observedAt: branch.observedAt?.toISOString() ?? null,
  }
}

function mapProjectHealth(health: ProjectHealth) {
  return {
    state: health.state,
    summary: health.summary,
    reasons: health.reasons.map((reason) => ({
      severity: reason.severity,
      code: reason.code,
      message: reason.message,
    })),
  }
}

function mapSynchronizationHistory(
  history: Awaited<ReturnType<ApplicationContext['projects']['getSynchronization']>>,
) {
  return {
    project: mapProject(history.project),
    health: mapProjectHealth(history.health),
    runs: history.runs.map((run) => ({
      ...mapSynchronizationSummary(run),
      requestedAt: run.requestedAt.toISOString(),
      coalescedCount: run.coalescedCount,
      forcePush: run.forcePush,
      triggerScope: run.triggerScope,
      issues: run.issues.map((issue) => ({
        ...issue,
        createdAt: issue.createdAt.toISOString(),
      })),
    })),
  }
}

function mapSynchronizationSummary(synchronization: ProjectSynchronizationSummary) {
  return {
    ...synchronization,
    startedAt: synchronization.startedAt.toISOString(),
    completedAt: synchronization.completedAt?.toISOString() ?? null,
  }
}

function mapReconciliation(reconciliation: ReconciliationRequestRecord): {
  readonly requestId: string
  readonly status: ReconciliationRequestRecord['status']
  readonly configurationVersion: number
  readonly reason: string
  readonly mode: 'full'
  readonly sourceSha: string
  readonly productionSha: string
  readonly requestedAt: string
}
function mapReconciliation(reconciliation: null): null
function mapReconciliation(
  reconciliation: ReconciliationRequestRecord | null,
): ReturnType<typeof mapReconciliationRecord> | null
function mapReconciliation(reconciliation: ReconciliationRequestRecord | null) {
  return reconciliation ? mapReconciliationRecord(reconciliation) : null
}

function mapReconciliationRecord(reconciliation: ReconciliationRequestRecord) {
  return {
    requestId: reconciliation.id,
    status: reconciliation.status,
    configurationVersion: reconciliation.configurationVersion,
    reason: reconciliation.reason,
    mode: reconciliation.mode,
    sourceSha: reconciliation.sourceSha,
    productionSha: reconciliation.productionSha,
    requestedAt: reconciliation.requestedAt.toISOString(),
  }
}

function mapProjectError(error: unknown): Error {
  if (error instanceof ApiHttpError) {
    return error
  }

  if (error instanceof ProjectNotFoundError) {
    return new ApiHttpError({ statusCode: 404, code: 'PROJECT_NOT_FOUND', message: error.message })
  }

  if (error instanceof RepositoryAlreadyConnectedError) {
    return new ApiHttpError({
      statusCode: 409,
      code: 'REPOSITORY_ALREADY_CONNECTED',
      message: error.message,
      details: { projectId: error.projectId, repositoryId: error.repositoryId },
    })
  }

  if (error instanceof ProjectVersionConflictError) {
    return new ApiHttpError({
      statusCode: 409,
      code: 'PROJECT_CONFIGURATION_VERSION_CONFLICT',
      message: error.message,
      details: { expected: error.expectedVersion, actual: error.actualVersion },
    })
  }

  if (error instanceof ProjectConfigurationValidationError) {
    const statusCode = getValidationStatusCode(error.code)

    return new ApiHttpError({
      statusCode,
      code: error.code.toUpperCase(),
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
      cause: error,
    })
  }

  if (error instanceof DatabaseOperationError && error.kind === 'conflict') {
    return new ApiHttpError({
      statusCode: 409,
      code: 'PROJECT_CONFLICT',
      message: 'Project configuration conflicts with current repository state',
      cause: error,
    })
  }

  return error instanceof Error ? error : new Error(String(error))
}

function getValidationStatusCode(code: ProjectConfigurationValidationError['code']): number {
  switch (code) {
    case 'permission_missing':
      return 403
    case 'external_state_unknown':
      return 503
    case 'installation_unavailable':
    case 'repository_unavailable':
    case 'app_permissions_missing':
    case 'repository_state_changed':
    case 'project_not_active':
      return 409
    case 'invalid_branch_name':
    case 'source_equals_production':
    case 'source_branch_missing':
    case 'production_branch_missing':
    case 'source_ref_not_commit':
    case 'production_ref_not_commit':
    case 'production_branch_not_ancestor':
      return 422
  }
}

function parseSafeId(value: string, name: string): number {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Stored ${name} is invalid: ${value}`)
  }

  return parsed
}

function requireSession(value: AuthenticatedSession | undefined): AuthenticatedSession {
  if (!value) {
    throw new ApiHttpError({
      statusCode: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: 'A valid Shipgate session is required',
    })
  }

  return value
}
