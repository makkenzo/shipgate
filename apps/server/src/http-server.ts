import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { performance } from 'node:perf_hooks'
import { assertDatabaseReady, checkDatabaseReadiness } from '@shipgate/database'
import {
  diagnosticJobPayloadSchema,
  enqueueJob,
  getJobExecution,
  getQueueMetrics,
} from '@shipgate/jobs'
import type { ApplicationContext } from './application-context.js'
import { resolveCorrelationId } from './correlation-id.js'
import type { StartedApplication } from './run-application.js'

export async function startHttpServer(context: ApplicationContext): Promise<StartedApplication> {
  await assertDatabaseReady(
    context.database.kysely,
    context.runtimeConfig.database.readinessTimeoutMs,
  )

  const server = createServer((request, response) => {
    ;(async () => {
      const startedAt = performance.now()

      const correlationId = resolveCorrelationId(request.headers['x-correlation-id'])

      const logger = context.loggerFor(correlationId)

      response.setHeader('x-correlation-id', correlationId)

      try {
        await handleRequest(context, request, response, correlationId)

        logger.info(
          {
            event: 'http.request.completed',

            http: {
              method: request.method,
              path: request.url,
              statusCode: response.statusCode,
            },

            durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
          },
          'HTTP request completed',
        )
      } catch (error) {
        logger.error(
          {
            event: 'http.request.failed',
            err: toError(error),

            http: {
              method: request.method,
              path: request.url,
            },
          },
          'HTTP request failed',
        )

        if (!response.headersSent) {
          writeJson(response, 500, {
            error: 'internal_server_error',
            correlationId,
          })
        } else {
          response.destroy()
        }
      }
    })()
  })

  const waitUntilStopped = new Promise<void>((resolve) => {
    server.once('close', resolve)
  })

  context.shutdown.addHook('http-server', async () => {
    await closeServer(server, context.runtimeConfig.shutdownTimeoutMs)
  })

  await listen(server, context.runtimeConfig.api.host, context.runtimeConfig.api.port)

  if (context.shutdown.signal.aborted) {
    await closeServer(server, context.runtimeConfig.shutdownTimeoutMs)
  }

  const address = server.address()

  return {
    startupFields: {
      http: {
        address: typeof address === 'object' && address ? address.address : undefined,

        port: typeof address === 'object' && address ? address.port : undefined,
      },
    },

    waitUntilStopped,
  }
}

async function handleRequest(
  context: ApplicationContext,
  request: IncomingMessage,
  response: ServerResponse,
  correlationId: string,
): Promise<void> {
  const method = request.method

  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname

  if (method === 'GET' && pathname === '/health/live') {
    writeJson(response, 200, {
      status: 'ok',
    })

    return
  }

  if (method === 'GET' && pathname === '/health/ready') {
    const readiness = await checkDatabaseReadiness(
      context.database.kysely,
      context.runtimeConfig.database.readinessTimeoutMs,
    )

    if (!readiness.ready) {
      writeJson(response, 503, {
        status: 'not_ready',

        checks: {
          database: {
            status: 'failed',
            latencyMs: readiness.latencyMs,
          },
        },
      })

      return
    }

    writeJson(response, 200, {
      status: 'ready',

      checks: {
        database: {
          status: 'ok',
          latencyMs: readiness.latencyMs,
        },
      },
    })

    return
  }

  if (method === 'POST' && pathname === '/internal/diagnostics/jobs') {
    const body = await readJsonBody(request)

    const parsed = diagnosticJobPayloadSchema.safeParse(body)

    if (!parsed.success) {
      writeJson(response, 400, {
        error: 'invalid_request',

        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),

          message: issue.message,
        })),
      })

      return
    }

    const job = await enqueueJob(context.database, 'diagnostic_echo', parsed.data, {
      correlationId,

      causationId: `http:${correlationId}`,
    })

    writeJson(response, 202, {
      jobId: job.jobId,
      status: 'queued',

      statusUrl: `/internal/jobs/${job.jobId}`,
    })

    return
  }

  const jobMatch = pathname.match(/^\/internal\/jobs\/(\d+)$/)

  if (method === 'GET' && jobMatch) {
    const jobId = jobMatch[1]

    if (!jobId) {
      writeJson(response, 400, {
        error: 'invalid_job_id',
      })

      return
    }

    const execution = await getJobExecution(context.database, jobId)

    if (!execution) {
      writeJson(response, 404, {
        error: 'job_not_found',
      })

      return
    }

    writeJson(response, 200, execution)

    return
  }

  if (method === 'GET' && pathname === '/internal/queue/metrics') {
    const metrics = await getQueueMetrics(
      context.database,

      context.runtimeConfig.jobs.heartbeatStaleAfterMs,
    )

    writeJson(response, 200, metrics)

    return
  }

  writeJson(response, 404, {
    error: 'not_found',
  })
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  })

  response.end(JSON.stringify(body))
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  const listening = once(server, 'listening')

  server.listen(port, host)

  await listening
}

async function closeServer(server: Server, timeoutMs: number): Promise<void> {
  if (!server.listening) {
    return
  }

  let forceCloseTimer: NodeJS.Timeout | undefined

  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })

  server.closeIdleConnections()

  forceCloseTimer = setTimeout(
    () => {
      server.closeAllConnections()
    },
    Math.max(1, timeoutMs - 100),
  )

  try {
    await closed
  } finally {
    clearTimeout(forceCloseTimer)
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let receivedBytes = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

    receivedBytes += buffer.length

    if (receivedBytes > 16_384) {
      throw new Error('Request body exceeds 16 KiB')
    }

    chunks.push(buffer)
  }

  if (chunks.length === 0) {
    return {}
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
