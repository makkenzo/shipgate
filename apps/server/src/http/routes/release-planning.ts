import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'

import { DatabaseOperationError } from '@shipgate/database'

import type { ApplicationContext } from '../../application-context.js'
import type { AuthenticatedSession } from '../../auth/model.js'
import { createCandidateService } from '../../projects/candidate-service.js'
import {
  createDependencyService,
  DependencyAuthorizationError,
  DependencySynchronizationError,
} from '../../projects/dependency-service.js'
import { DependencyValidationError } from '../../projects/dependency-workflow.js'
import {
  ChangeNotFoundError,
  ProjectConfigurationValidationError,
  ProjectNotFoundError,
} from '../../projects/errors.js'
import { ApiHttpError } from '../api-error.js'
import { CsrfHeadersSchema } from '../auth-schemas.js'
import { ApiErrorSchema } from '../schemas.js'
import { requireAuthenticatedSession, requireCsrfProtection } from '../session-middleware.js'

const ProjectParamsSchema = Type.Object(
  { projectId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
)

const CandidateExclusionBodySchema = Type.Object(
  { reason: Type.Optional(Type.String({ maxLength: 4_000 })) },
  { additionalProperties: false },
)

const CandidateExclusionSchema = Type.Object(
  {
    changeId: Type.String(),
    pullRequestNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    title: Type.Union([Type.String(), Type.Null()]),
    actorGitHubUserId: Type.Integer({ minimum: 1 }),
    reason: Type.Union([Type.String(), Type.Null()]),
    candidateVersion: Type.Integer({ minimum: 1 }),
    excludedAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
)

const CandidateEvaluationSchema = Type.Object(
  {
    id: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    result: Type.Union([Type.Literal('ready'), Type.Literal('blocked')]),
    summary: Type.Unknown(),
    blockers: Type.Unknown(),
    evaluatedAt: Type.String(),
    projectStateVersion: Type.Integer({ minimum: 0 }),
    projectionVersion: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)

const CandidatePendingEvaluationSchema = Type.Object(
  {
    requestId: Type.String(),
    status: Type.Union([Type.Literal('queued'), Type.Literal('running')]),
    reasons: Type.Array(Type.String()),
    coalescedCount: Type.Integer({ minimum: 0 }),
    requestedAt: Type.String(),
    claimedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
)

const ActiveCandidateSchema = Type.Object(
  {
    id: Type.String(),
    sequence: Type.Integer({ minimum: 1 }),
    version: Type.Integer({ minimum: 1 }),
    status: Type.Union([
      Type.Literal('evaluating'),
      Type.Literal('ready'),
      Type.Literal('blocked'),
    ]),
    createdByGitHubUserId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    latestEvaluationVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    latestEvaluation: Type.Union([CandidateEvaluationSchema, Type.Null()]),
    pendingEvaluation: Type.Union([CandidatePendingEvaluationSchema, Type.Null()]),
    exclusions: Type.Array(CandidateExclusionSchema),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
)

const ActiveCandidateResponseSchema = Type.Object(
  { candidate: Type.Union([ActiveCandidateSchema, Type.Null()]) },
  { additionalProperties: false },
)

const CandidateExclusionMutationResponseSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('recorded'), Type.Literal('already_applied')]),
    candidateId: Type.String(),
    candidateVersion: Type.Integer({ minimum: 1 }),
    changeId: Type.String(),
    excluded: Type.Boolean(),
    evaluationRequestId: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
)

const ProjectChangeParamsSchema = Type.Object(
  {
    projectId: Type.String({ minLength: 1, maxLength: 128 }),
    changeId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
)

const ProjectChangeDependencyParamsSchema = Type.Object(
  {
    projectId: Type.String({ minLength: 1, maxLength: 128 }),
    changeId: Type.String({ minLength: 1, maxLength: 128 }),
    dependencyChangeId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
)

const SetDependenciesBodySchema = Type.Object(
  {
    dependencyChangeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 100,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
)

const ChangeDependencySchema = Type.Object(
  {
    changeId: Type.String(),
    pullRequestNumber: Type.Integer({ minimum: 1 }),
    source: Type.Union([
      Type.Literal('user'),
      Type.Literal('managed_pr_body'),
      Type.Literal('system'),
    ]),
    actorGitHubUserId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
)

const DependencyListResponseSchema = Type.Object(
  { dependencies: Type.Array(ChangeDependencySchema) },
  { additionalProperties: false },
)

const DependencyMutationResponseSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('recorded'), Type.Literal('already_applied')]),
    dependentChangeId: Type.String(),
    dependentPullRequestNumber: Type.Integer({ minimum: 1 }),
    dependencies: Type.Array(ChangeDependencySchema),
    candidateReevaluation: Type.Union([
      Type.Object(
        {
          candidateId: Type.String(),
          candidateVersion: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    githubBodyUpdated: Type.Boolean(),
  },
  { additionalProperties: false },
)

export const releasePlanningRoutes: FastifyPluginAsyncTypebox<{
  readonly context: ApplicationContext
}> = async (app, { context }) => {
  const candidates = createCandidateService({
    database: context.database,
    githubRepositoryAccess: context.githubRepositoryAccess,
  })

  const dependencies = createDependencyService({
    database: context.database,
    githubAuth: context.githubAuth,
  })

  app.get(
    '/projects/:projectId/release-candidate',
    {
      preHandler: [requireAuthenticatedSession],
      schema: {
        operationId: 'getProjectReleaseCandidate',
        summary: 'Get the active dynamic draft release candidate',
        tags: ['Release planning'],
        security: [{ shipgateSession: [] }],
        params: ProjectParamsSchema,
        response: { 200: ActiveCandidateResponseSchema, default: ApiErrorSchema },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)

      try {
        const candidate = await candidates.get({
          actorGitHubUserId: session.githubUserId,
          projectId: request.params.projectId,
        })

        return { candidate: candidate ? mapCandidate(candidate) : null }
      } catch (error) {
        throw mapCandidateError(error)
      }
    },
  )

  app.put(
    '/projects/:projectId/changes/:changeId/exclusion',
    {
      preHandler: [requireAuthenticatedSession, requireCsrfProtection],
      schema: {
        operationId: 'excludeProjectChangeFromCandidate',
        summary: 'Exclude one change from the active draft candidate',
        tags: ['Release planning'],
        security: [{ shipgateSession: [] }],
        headers: CsrfHeadersSchema,
        params: ProjectChangeParamsSchema,
        body: CandidateExclusionBodySchema,
        response: { 200: CandidateExclusionMutationResponseSchema, default: ApiErrorSchema },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)

      try {
        return await candidates.exclude({
          actorGitHubUserId: session.githubUserId,
          projectId: request.params.projectId,
          changeId: request.params.changeId,
          correlationId: request.id,
          ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
        })
      } catch (error) {
        throw mapCandidateError(error)
      }
    },
  )

  app.delete(
    '/projects/:projectId/changes/:changeId/exclusion',
    {
      preHandler: [requireAuthenticatedSession, requireCsrfProtection],
      schema: {
        operationId: 'restoreProjectChangeToCandidate',
        summary: 'Restore one explicitly excluded change to the active draft candidate',
        tags: ['Release planning'],
        security: [{ shipgateSession: [] }],
        headers: CsrfHeadersSchema,
        params: ProjectChangeParamsSchema,
        response: { 200: CandidateExclusionMutationResponseSchema, default: ApiErrorSchema },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)

      try {
        return await candidates.restore({
          actorGitHubUserId: session.githubUserId,
          projectId: request.params.projectId,
          changeId: request.params.changeId,
          correlationId: request.id,
        })
      } catch (error) {
        throw mapCandidateError(error)
      }
    },
  )

  app.get(
    '/projects/:projectId/changes/:changeId/dependencies',
    {
      preHandler: [requireAuthenticatedSession],
      schema: {
        operationId: 'getProjectChangeDependencies',
        summary: 'List Shipgate dependencies for a change',
        tags: ['Release planning'],
        security: [{ shipgateSession: [] }],
        params: ProjectChangeParamsSchema,
        response: { 200: DependencyListResponseSchema, default: ApiErrorSchema },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)

      try {
        const result = await dependencies.list({
          actorGitHubUserId: session.githubUserId,
          projectId: request.params.projectId,
          changeId: request.params.changeId,
        })

        return { dependencies: result.map(mapDependency) }
      } catch (error) {
        throw mapDependencyError(error)
      }
    },
  )

  app.put(
    '/projects/:projectId/changes/:changeId/dependencies',
    {
      preHandler: [requireAuthenticatedSession, requireCsrfProtection],
      schema: {
        operationId: 'setProjectChangeDependencies',
        summary: 'Replace dependencies and synchronize the PR managed block',
        tags: ['Release planning'],
        security: [{ shipgateSession: [] }],
        headers: CsrfHeadersSchema,
        params: ProjectChangeParamsSchema,
        body: SetDependenciesBodySchema,
        response: { 200: DependencyMutationResponseSchema, default: ApiErrorSchema },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)

      try {
        return mapMutation(
          await dependencies.set({
            actorGitHubUserId: session.githubUserId,
            projectId: request.params.projectId,
            changeId: request.params.changeId,
            dependencyChangeIds: request.body.dependencyChangeIds,
            correlationId: request.id,
          }),
        )
      } catch (error) {
        throw mapDependencyError(error)
      }
    },
  )

  app.delete(
    '/projects/:projectId/changes/:changeId/dependencies/:dependencyChangeId',
    {
      preHandler: [requireAuthenticatedSession, requireCsrfProtection],
      schema: {
        operationId: 'removeProjectChangeDependency',
        summary: 'Remove one dependency and synchronize the PR managed block',
        tags: ['Release planning'],
        security: [{ shipgateSession: [] }],
        headers: CsrfHeadersSchema,
        params: ProjectChangeDependencyParamsSchema,
        response: { 200: DependencyMutationResponseSchema, default: ApiErrorSchema },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)

      try {
        return mapMutation(
          await dependencies.remove({
            actorGitHubUserId: session.githubUserId,
            projectId: request.params.projectId,
            changeId: request.params.changeId,
            dependencyChangeId: request.params.dependencyChangeId,
            correlationId: request.id,
          }),
        )
      } catch (error) {
        throw mapDependencyError(error)
      }
    },
  )
}

function mapCandidate(
  candidate: Awaited<ReturnType<ReturnType<typeof createCandidateService>['get']>>,
) {
  if (!candidate) return null

  return {
    id: candidate.id,
    sequence: candidate.sequence,
    version: candidate.version,
    status: candidate.status,
    createdByGitHubUserId:
      candidate.createdByGitHubUserId === null
        ? null
        : parseSafeGitHubId(candidate.createdByGitHubUserId),
    latestEvaluationVersion: candidate.latestEvaluationVersion,
    latestEvaluation: candidate.latestEvaluation
      ? {
          id: candidate.latestEvaluation.id,
          version: candidate.latestEvaluation.version,
          result: candidate.latestEvaluation.result,
          summary: candidate.latestEvaluation.summary,
          blockers: candidate.latestEvaluation.blockers,
          evaluatedAt: candidate.latestEvaluation.evaluatedAt.toISOString(),
          projectStateVersion: candidate.latestEvaluation.projectStateVersion,
          projectionVersion: candidate.latestEvaluation.projectionVersion,
        }
      : null,
    pendingEvaluation: candidate.pendingEvaluation
      ? {
          requestId: candidate.pendingEvaluation.requestId,
          status: candidate.pendingEvaluation.status,
          reasons: [...candidate.pendingEvaluation.reasons],
          coalescedCount: candidate.pendingEvaluation.coalescedCount,
          requestedAt: candidate.pendingEvaluation.requestedAt.toISOString(),
          claimedAt: candidate.pendingEvaluation.claimedAt?.toISOString() ?? null,
        }
      : null,
    exclusions: candidate.exclusions.map((exclusion) => ({
      changeId: exclusion.changeId,
      pullRequestNumber: exclusion.pullRequestNumber,
      title: exclusion.title,
      actorGitHubUserId: parseSafeGitHubId(exclusion.actorGitHubUserId),
      reason: exclusion.reason,
      candidateVersion: exclusion.candidateVersion,
      excludedAt: exclusion.excludedAt.toISOString(),
      updatedAt: exclusion.updatedAt.toISOString(),
    })),
    createdAt: candidate.createdAt.toISOString(),
    updatedAt: candidate.updatedAt.toISOString(),
  }
}

function mapCandidateError(error: unknown): Error {
  if (error instanceof ProjectNotFoundError) {
    return new ApiHttpError({ statusCode: 404, code: 'PROJECT_NOT_FOUND', message: error.message })
  }

  if (error instanceof ChangeNotFoundError) {
    return new ApiHttpError({
      statusCode: 404,
      code: 'CHANGE_NOT_FOUND',
      message: error.message,
      details: { projectId: error.projectId, changeId: error.changeId },
    })
  }

  if (error instanceof ProjectConfigurationValidationError) {
    const statusCode =
      error.code === 'permission_missing'
        ? 403
        : error.code === 'external_state_unknown'
          ? 503
          : error.code === 'invalid_exclusion_reason'
            ? 422
            : 409

    return new ApiHttpError({
      statusCode,
      code: error.code.toUpperCase(),
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    })
  }

  if (error instanceof DatabaseOperationError) {
    return new ApiHttpError({
      statusCode: error.retryable ? 503 : 409,
      code: error.retryable ? 'DATABASE_UNAVAILABLE' : 'CANDIDATE_CONFLICT',
      message: 'Release candidate persistence failed',
    })
  }

  return error instanceof Error ? error : new Error('Unknown candidate workflow failure')
}

function mapMutation(result: Awaited<ReturnType<DependencyServiceSet>>) {
  return {
    status: result.status,
    dependentChangeId: result.dependentChangeId,
    dependentPullRequestNumber: result.dependentPullRequestNumber,
    dependencies: result.dependencies.map(mapDependency),
    candidateReevaluation: result.candidateReevaluation
      ? {
          candidateId: result.candidateReevaluation.candidateId,
          candidateVersion: result.candidateReevaluation.candidateVersion,
        }
      : null,
    githubBodyUpdated: result.githubBodyUpdated,
  }
}

type DependencyServiceSet = ReturnType<typeof createDependencyService>['set']

function mapDependency(dependency: {
  readonly changeId: string
  readonly pullRequestNumber: number
  readonly source: 'user' | 'managed_pr_body' | 'system'
  readonly actorGitHubUserId: string | null
  readonly version: number
  readonly updatedAt: Date
}) {
  return {
    changeId: dependency.changeId,
    pullRequestNumber: dependency.pullRequestNumber,
    source: dependency.source,
    actorGitHubUserId:
      dependency.actorGitHubUserId === null
        ? null
        : parseSafeGitHubId(dependency.actorGitHubUserId),
    version: dependency.version,
    updatedAt: dependency.updatedAt.toISOString(),
  }
}

function requireSession(session: AuthenticatedSession | undefined): AuthenticatedSession {
  if (!session) {
    throw new ApiHttpError({
      statusCode: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication is required',
    })
  }

  return session
}

function mapDependencyError(error: unknown): Error {
  if (error instanceof ProjectNotFoundError) {
    return new ApiHttpError({ statusCode: 404, code: 'PROJECT_NOT_FOUND', message: error.message })
  }

  if (error instanceof ChangeNotFoundError) {
    return new ApiHttpError({
      statusCode: 404,
      code: 'CHANGE_NOT_FOUND',
      message: error.message,
      details: { projectId: error.projectId, changeId: error.changeId },
    })
  }

  if (error instanceof DependencyAuthorizationError) {
    return new ApiHttpError({
      statusCode: error.code === 'permission_missing' ? 403 : 503,
      code: error.code === 'permission_missing' ? 'PERMISSION_MISSING' : 'EXTERNAL_STATE_UNKNOWN',
      message: error.message,
    })
  }

  if (error instanceof DependencyValidationError) {
    const statusCode =
      error.code === 'dependency_target_not_found'
        ? 422
        : error.code === 'invalid_dependency_block'
          ? 422
          : 409

    return new ApiHttpError({
      statusCode,
      code: error.code.toUpperCase(),
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    })
  }

  if (error instanceof DependencySynchronizationError) {
    return new ApiHttpError({
      statusCode: 502,
      code: 'GITHUB_DEPENDENCY_SYNC_FAILED',
      message: error.message,
      details: { rollbackFailed: error.rollbackFailed },
    })
  }

  if (error instanceof DatabaseOperationError) {
    return new ApiHttpError({
      statusCode: error.retryable ? 503 : 409,
      code: error.retryable ? 'DATABASE_UNAVAILABLE' : 'DEPENDENCY_CONFLICT',
      message: 'Dependency persistence failed',
    })
  }

  return error instanceof Error ? error : new Error('Unknown dependency workflow failure')
}

function parseSafeGitHubId(value: string): number {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Stored GitHub user ID is outside the safe integer range: ${value}`)
  }

  return parsed
}
