import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

import { checkDatabaseReadiness } from '@shipgate/database'
import { getQueueMetrics, isJobQueueInstalled, type QueueMetrics } from '@shipgate/jobs'

import type { ApplicationContext } from '../../application-context.js'
import { ApiHttpError } from '../api-error.js'
import type { ApiMetrics } from '../metrics.js'
import { ApiErrorSchema, HealthResponseSchema, ReadyResponseSchema } from '../schemas.js'

interface OperationalRoutesOptions {
  readonly context: ApplicationContext

  readonly metrics: ApiMetrics | undefined
}

export const operationalRoutes: FastifyPluginAsyncTypebox<OperationalRoutesOptions> = async (
  app,
  options,
) => {
  const { context, metrics } = options

  app.get(
    '/health',
    {
      schema: {
        operationId: 'getHealth',

        tags: ['Operations'],

        summary: 'Process liveness',

        response: {
          200: HealthResponseSchema,

          default: ApiErrorSchema,
        },
      },
    },
    async () => ({
      status: 'ok' as const,

      version: context.runtimeConfig.appVersion,

      uptimeSeconds: Math.floor(process.uptime()),
    }),
  )

  app.get(
    '/ready',
    {
      schema: {
        operationId: 'getReadiness',

        tags: ['Operations'],

        summary: 'Application readiness',

        response: {
          200: ReadyResponseSchema,

          default: ApiErrorSchema,
        },
      },
    },
    async () => {
      const database = await checkDatabaseReadiness(
        context.database.kysely,

        context.runtimeConfig.database.readinessTimeoutMs,
      )

      if (!database.ready) {
        throw new ApiHttpError({
          statusCode: 503,

          code: 'SERVICE_NOT_READY',

          message: 'Service is not ready',

          details: {
            checks: {
              database: {
                status: 'failed',

                latencyMs: database.latencyMs,
              },

              jobQueue: {
                status: 'unknown',
              },
            },
          },
        })
      }

      const jobQueueInstalled = await isJobQueueInstalled(context.database)

      if (!jobQueueInstalled) {
        throw new ApiHttpError({
          statusCode: 503,

          code: 'SERVICE_NOT_READY',

          message: 'Service is not ready',

          details: {
            checks: {
              database: {
                status: 'ok',

                latencyMs: database.latencyMs,
              },

              jobQueue: {
                status: 'not_installed',
              },
            },
          },
        })
      }

      let queueMetrics: QueueMetrics

      try {
        queueMetrics = await getQueueMetrics(
          context.database,

          context.runtimeConfig.jobs.heartbeatStaleAfterMs,
        )
      } catch (cause) {
        throw new ApiHttpError({
          statusCode: 503,
          code: 'SERVICE_NOT_READY',
          message: 'Service is not ready',
          cause,

          details: {
            checks: {
              database: {
                status: 'ok',
                latencyMs: database.latencyMs,
              },

              jobQueue: {
                status: 'unknown',
              },

              worker: {
                status: 'unknown',
              },
            },
          },
        })
      }

      return {
        status: 'ready' as const,

        checks: {
          database: {
            status: 'ok' as const,

            latencyMs: database.latencyMs,
          },

          jobQueue: {
            status: 'ok' as const,
          },

          worker: {
            status: queueMetrics.workers.active > 0 ? ('ok' as const) : ('unavailable' as const),

            activeWorkers: queueMetrics.workers.active,

            staleWorkers: queueMetrics.workers.stale,
          },
        },
      }
    },
  )

  if (metrics) {
    app.get(
      '/metrics',
      {
        schema: {
          hide: true,
        },
      },
      async (_request, reply) => {
        const output = await metrics.render()

        return reply.type(output.contentType).send(output.body)
      },
    )
  }

  /*
   * Защищаем operational endpoints
   * от случайного JSON-кеширования.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url === '/health' || request.url === '/ready' || request.url === '/metrics') {
      reply.header('cache-control', 'no-store')
    }

    return payload
  })
}
