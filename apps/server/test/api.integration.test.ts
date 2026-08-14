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

  it('allows only configured cross-origin browser requests', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        origin: 'http://localhost:5173',
      },
    })

    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173')

    const rejected = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        origin: 'https://untrusted.example',
      },
    })

    expect(rejected.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('publishes the browser API contract without exposing callback or webhook internals', () => {
    const document = app.swagger()
    const paths = document.paths ?? {}

    expect('openapi' in document ? document.openapi : undefined).toBe('3.1.0')

    expect(paths['/api/v1/auth/session']?.get?.operationId).toBe('getAuthSession')
    expect(paths['/api/v1/auth/logout']?.post?.operationId).toBe('logout')
    expect(paths['/api/v1/auth/disconnect']?.post?.operationId).toBe('disconnectGitHub')
    expect(paths['/api/v1/connection']?.get?.operationId).toBe('getConnectionConfiguration')
    expect(paths['/api/v1/installations']?.get?.operationId).toBe('getInstallations')
    expect(paths['/api/v1/installations/{installationId}']?.get?.operationId).toBe(
      'getInstallation',
    )
    expect(paths['/api/v1/account']?.delete?.operationId).toBe('deleteLocalAccount')
    expect(paths['/api/v1/projects']?.post?.operationId).toBe('createProject')
    expect(paths['/api/v1/projects']?.get?.operationId).toBe('getProjects')
    expect(paths['/api/v1/projects/{projectId}']?.get?.operationId).toBe('getProject')
    expect(paths['/api/v1/projects/{projectId}']?.patch?.operationId).toBe('updateProject')
    expect(paths['/api/v1/projects/{projectId}']?.delete?.operationId).toBe('deleteProject')
    expect(paths['/api/v1/projects/{projectId}/changes/{changeId}/qa']?.put?.operationId).toBe(
      'setProjectChangeQa',
    )

    expect(paths['/api/v1/auth/github']).toBeUndefined()
    expect(paths['/api/v1/auth/github/callback']).toBeUndefined()
    expect(paths['/api/v1/github/webhooks']).toBeUndefined()
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

  it('does not expose internal endpoints when they are disabled', async () => {
    const restrictedContext = createApplicationContext({
      processKind: 'api',

      environment: createTestEnvironment(postgres.connectionString, {
        API_DIAGNOSTICS_ENABLED: 'false',
        API_METRICS_ENABLED: 'false',
      }),
    })

    const restrictedApp = await buildApiApplication(restrictedContext)

    try {
      await restrictedApp.ready()

      const diagnosticResponse = await restrictedApp.inject({
        method: 'POST',
        url: '/api/v1/_diagnostics/jobs',
        headers: {
          'content-type': 'application/json',
        },
        payload: {
          message: 'must not be accepted',
        },
      })

      expect(diagnosticResponse.statusCode).toBe(404)

      const metricsResponse = await restrictedApp.inject({
        method: 'GET',
        url: '/metrics',
      })

      expect(metricsResponse.statusCode).toBe(404)
    } finally {
      await restrictedApp.close()
      await restrictedContext.database.destroy()
    }
  })

  it('keeps the API ready when the independently deployed worker is unavailable', async () => {
    await worker.stop()

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
          status: 'unavailable',
          activeWorkers: 0,
        },
      },
    })
  })
})
