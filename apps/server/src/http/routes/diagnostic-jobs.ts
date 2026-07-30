import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'

import { enqueueJob, getJobExecution } from '@shipgate/jobs'

import type { ApplicationContext } from '../../application-context.js'
import { ApiHttpError } from '../api-error.js'
import { ApiErrorSchema } from '../schemas.js'

const DiagnosticJobRequestSchema = Type.Object(
  {
    message: Type.String({
      minLength: 1,
      maxLength: 1_000,
    }),

    outcome: Type.Optional(
      Type.Union([
        Type.Literal('success'),

        Type.Literal('retryable-error'),

        Type.Literal('permanent-error'),
      ]),
    ),

    failUntilAttempt: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10,
      }),
    ),

    delayMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 30_000,
      }),
    ),
  },
  {
    additionalProperties: false,

    title: 'DiagnosticJobRequest',
  },
)

const DiagnosticJobAcceptedSchema = Type.Object(
  {
    jobId: Type.String({
      minLength: 1,
    }),

    status: Type.Literal('queued'),

    requestId: Type.String({
      minLength: 1,
    }),

    statusUrl: Type.String({
      minLength: 1,
    }),
  },
  {
    additionalProperties: false,

    title: 'DiagnosticJobAccepted',
  },
)

const DiagnosticJobParamsSchema = Type.Object(
  {
    jobId: Type.String({
      pattern: '^[0-9]+$',
    }),
  },
  {
    additionalProperties: false,
  },
)

const DiagnosticJobResponseSchema = Type.Object(
  {
    jobId: Type.String(),

    taskIdentifier: Type.String(),

    status: Type.Union([
      Type.Literal('queued'),
      Type.Literal('running'),
      Type.Literal('retrying'),
      Type.Literal('succeeded'),
      Type.Literal('failed'),
    ]),

    correlationId: Type.String(),

    causationId: Type.Union([Type.String(), Type.Null()]),

    payload: Type.Unknown(),

    attempts: Type.Integer({
      minimum: 0,
    }),

    maxAttempts: Type.Integer({
      minimum: 1,
    }),

    result: Type.Unknown(),

    lastError: Type.Unknown(),

    queuedAt: Type.String(),

    startedAt: Type.Union([Type.String(), Type.Null()]),

    completedAt: Type.Union([Type.String(), Type.Null()]),

    updatedAt: Type.String(),
  },
  {
    additionalProperties: false,

    title: 'DiagnosticJob',
  },
)

interface DiagnosticJobRoutesOptions {
  readonly context: ApplicationContext
}

export const diagnosticJobRoutes: FastifyPluginAsyncTypebox<DiagnosticJobRoutesOptions> = async (
  app,
  options,
) => {
  const { context } = options

  app.post(
    '/_diagnostics/jobs',
    {
      schema: {
        operationId: 'createDiagnosticJob',

        tags: ['Diagnostics'],

        summary: 'Enqueue a diagnostic job',

        description: 'Infrastructure-only endpoint. It is not part of the Shipgate product API.',

        body: DiagnosticJobRequestSchema,

        response: {
          202: DiagnosticJobAcceptedSchema,

          default: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const job = await enqueueJob(
        context.database,

        'diagnostic_echo',

        request.body,

        {
          correlationId: request.id,

          causationId: `http:${request.id}`,
        },
      )

      const statusUrl = `/api/v1/_diagnostics/jobs/${job.jobId}`

      return reply.code(202).send({
        jobId: job.jobId,
        status: 'queued' as const,

        requestId: request.id,

        statusUrl,
      })
    },
  )

  app.get(
    '/_diagnostics/jobs/:jobId',
    {
      schema: {
        operationId: 'getDiagnosticJob',

        tags: ['Diagnostics'],

        summary: 'Get diagnostic job state',

        description: 'Infrastructure-only endpoint. It is not part of the Shipgate product API.',

        params: DiagnosticJobParamsSchema,

        response: {
          200: DiagnosticJobResponseSchema,

          default: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const execution = await getJobExecution(
        context.database,

        request.params.jobId,
      )

      if (!execution) {
        throw new ApiHttpError({
          statusCode: 404,

          code: 'DIAGNOSTIC_JOB_NOT_FOUND',

          message: 'Diagnostic job not found',
        })
      }

      return {
        jobId: execution.jobId,

        taskIdentifier: execution.taskIdentifier,

        status: execution.status,

        correlationId: execution.correlationId,

        causationId: execution.causationId,

        payload: execution.payload,

        attempts: execution.attempts,

        maxAttempts: execution.maxAttempts,

        result: execution.result,

        lastError: execution.lastError,

        queuedAt: execution.queuedAt.toISOString(),

        startedAt: execution.startedAt?.toISOString() ?? null,

        completedAt: execution.completedAt?.toISOString() ?? null,

        updatedAt: execution.updatedAt.toISOString(),
      }
    },
  )
}
