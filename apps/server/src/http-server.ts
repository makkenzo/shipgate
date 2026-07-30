import { once } from 'node:events'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { performance } from 'node:perf_hooks'
import { assertDatabaseReady, checkDatabaseReadiness } from '@shipgate/database'
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
        await handleRequest(context, request.method, request.url, response)

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
  method: string | undefined,
  url: string | undefined,
  response: ServerResponse,
): Promise<void> {
  const pathname = new URL(url ?? '/', 'http://localhost').pathname

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
