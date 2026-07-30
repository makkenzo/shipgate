import { migrateToLatest } from '@shipgate/database'
import {
  type JobWorkerRuntime,
  migrateJobQueue,
  startJobWorker,
  waitForJobExecution,
} from '@shipgate/jobs'
import {
  createTestEnvironment,
  type PostgresTestDatabase,
  startPostgresTestDatabase,
} from '@shipgate/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type ApplicationContext, createApplicationContext } from '../src/application-context.js'
import { buildApiApplication } from '../src/http/api-app.js'

describe.sequential('Fastify API', () => {
  let postgres: PostgresTestDatabase
  let context: ApplicationContext
  let worker: JobWorkerRuntime
  let app: FastifyInstance

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()

    context = createApplicationContext({
      processKind: 'api',

      environment: createTestEnvironment(postgres.connectionString),
    })

    await migrateJobQueue(context.database)

    await migrateToLatest(context.database.kysely)

    worker = await startJobWorker({
      dependencies: {
        database: context.database,
        logger: context.logger,
      },

      appVersion: 'test',
      concurrency: 1,
      pollIntervalMs: 100,
      heartbeatIntervalMs: 1000,
      shutdownAbortTimeoutMs: 3000,
    })

    app = await buildApiApplication(context)

    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await worker.stop()
    await context.database.destroy()
    await postgres.stop()
  })

  it('serves health and readiness', async () => {
    const health = await app.inject({
      method: 'GET',
      url: '/health',
    })

    expect(health.statusCode).toBe(200)

    expect(health.json()).toMatchObject({
      status: 'ok',
      version: 'test',
    })

    const readiness = await app.inject({
      method: 'GET',
      url: '/ready',
    })

    expect(readiness.statusCode).toBe(200)

    expect(readiness.json()).toMatchObject({
      status: 'ready',

      checks: {
        database: {
          status: 'ok',
        },

        worker: {
          status: 'ok',
          activeWorkers: 1,
        },
      },
    })
  })

  it('returns the shared validation error contract', async () => {
    const response = await app.inject({
      method: 'POST',

      url: '/api/v1/_diagnostics/jobs',

      headers: {
        'content-type': 'application/json',

        'x-request-id': 'api-integration-test',
      },

      payload: {
        message: 123,
        unexpected: true,
      },
    })

    expect(response.statusCode).toBe(400)

    expect(response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      requestId: 'api-integration-test',
    })
  })

  it('enqueues and executes a diagnostic job', async () => {
    const response = await app.inject({
      method: 'POST',

      url: '/api/v1/_diagnostics/jobs',

      headers: {
        'content-type': 'application/json',

        'x-request-id': 'api-job-integration',
      },

      payload: {
        message: 'API integration job',
        outcome: 'success',
      },
    })

    expect(response.statusCode).toBe(202)

    const accepted = response.json<{
      readonly jobId: string
    }>()

    const execution = await waitForJobExecution(context.database, accepted.jobId, {
      timeoutMs: 20_000,
    })

    expect(execution).toMatchObject({
      status: 'succeeded',
      attempts: 1,

      correlationId: 'api-job-integration',

      result: {
        echoedMessage: 'API integration job',
      },
    })
  })
})
