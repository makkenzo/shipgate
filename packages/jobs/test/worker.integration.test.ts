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
      concurrency: 2,
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

  it('executes concurrently enqueued jobs independently', async () => {
    const queuedJobs = await Promise.all(
      Array.from({ length: 4 }, async (_, index) =>
        enqueueJob(
          database,
          'diagnostic_echo',
          {
            message: `concurrent job ${index}`,
            outcome: 'success',
            delayMs: 100,
          },
          {
            correlationId: `worker-test-concurrent-${index}`,
          },
        ),
      ),
    )

    const executions = await Promise.all(
      queuedJobs.map(async (job) =>
        waitForJobExecution(database, job.jobId, {
          timeoutMs: 20_000,
        }),
      ),
    )

    expect(new Set(queuedJobs.map((job) => job.jobId)).size).toBe(queuedJobs.length)
    expect(executions.every((execution) => execution.status === 'succeeded')).toBe(true)
    expect(executions.every((execution) => execution.attempts === 1)).toBe(true)
  })

  it('acknowledges permanent failures without retrying them', async () => {
    const queued = await enqueueJob(
      database,
      'diagnostic_echo',
      {
        message: 'permanent failure',
        outcome: 'permanent-error',
      },
      {
        correlationId: 'worker-test-permanent-failure',
      },
    )

    const execution = await waitForJobExecution(database, queued.jobId, {
      timeoutMs: 20_000,
    })

    expect(execution).toMatchObject({
      status: 'failed',
      attempts: 1,

      lastError: {
        code: 'DIAGNOSTIC_PERMANENT_FAILURE',
      },
    })
  })
})
