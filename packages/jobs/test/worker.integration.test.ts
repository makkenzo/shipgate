import { createDatabase, type DatabaseClient, migrateToLatest } from '@shipgate/database'
import {
  enqueueJob,
  type JobWorkerRuntime,
  migrateJobQueue,
  startJobWorker,
  waitForJobExecution,
} from '@shipgate/jobs'
import { createNoopJobLogger } from '@shipgate/jobs/testing'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe.sequential('Graphile Worker', () => {
  let postgres: PostgresTestDatabase

  let database: DatabaseClient

  let worker: JobWorkerRuntime

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()

    database = createDatabase({
      connectionString: postgres.connectionString,

      applicationName: 'shipgate-worker-test',

      ssl: {
        mode: 'disable',
      },

      pool: {
        min: 0,
        max: 4,
        idleTimeoutMs: 5000,
        connectionTimeoutMs: 5000,
        maxLifetimeSeconds: 0,
      },

      allowExitOnIdle: true,
      onPoolError: () => undefined,
    })

    await migrateJobQueue(database)
    await migrateToLatest(database.kysely)

    worker = await startJobWorker({
      dependencies: {
        database,

        logger: createNoopJobLogger(),
      },

      appVersion: 'test',
      concurrency: 1,
      pollIntervalMs: 100,
      heartbeatIntervalMs: 1000,
      shutdownAbortTimeoutMs: 3000,
    })
  })

  afterAll(async () => {
    await worker.stop()
    await database.destroy()
    await postgres.stop()
  })

  it('executes a persisted job', async () => {
    const queued = await enqueueJob(
      database,
      'diagnostic_echo',
      {
        message: 'worker integration',
        outcome: 'success',
      },
      {
        correlationId: 'worker-test-success',
      },
    )

    const execution = await waitForJobExecution(database, queued.jobId, {
      timeoutMs: 20_000,
    })

    expect(execution).toMatchObject({
      status: 'succeeded',
      attempts: 1,
    })
  })

  it('retries a failed attempt', async () => {
    const queued = await enqueueJob(
      database,
      'diagnostic_echo',
      {
        message: 'retry once',

        outcome: 'retryable-error',

        failUntilAttempt: 1,
      },
      {
        correlationId: 'worker-test-retry',
      },
    )

    const execution = await waitForJobExecution(database, queued.jobId, {
      timeoutMs: 30_000,
    })

    expect(execution).toMatchObject({
      status: 'succeeded',
      attempts: 2,
    })
  })
})
