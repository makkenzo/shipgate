import { randomUUID } from 'node:crypto'

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

  const repositorySyncExecutions: string[] = []

  const requiredCheckSyncExecutions: string[] = []

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

        async repositoryInitialSync(execution) {
          repositorySyncExecutions.push(execution.requestId)
          return { requestId: execution.requestId, status: 'succeeded' }
        },

        async repositoryRequiredChecksSync(execution) {
          requiredCheckSyncExecutions.push(execution.projectId)
          return { projectId: execution.projectId, status: 'applied' }
        },
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

  it('dispatches the durable repository.initial-sync task', async () => {
    const requestId = randomUUID()
    const queued = await enqueueJob(
      database,
      'repository.initial-sync',
      { requestId },
      {
        correlationId: `worker-test-repository-initial-sync-${requestId}`,
        jobKey: `repository.initial-sync:${requestId}`,
      },
    )
    const execution = await waitForJobExecution(database, queued.jobId, {
      timeoutMs: 20_000,
    })

    expect(execution).toMatchObject({
      taskIdentifier: 'repository.initial-sync',
      status: 'succeeded',
      attempts: 1,
    })
    expect(repositorySyncExecutions).toContain(requestId)
  })

  it('dispatches the durable repository.required-checks-sync task', async () => {
    const projectId = randomUUID()
    const queued = await enqueueJob(
      database,
      'repository.required-checks-sync',
      {
        projectId,
        repositoryId: '456',
        configurationVersion: 3,
        refreshPolicy: true,
        reason: 'worker_integration_test',
      },
      {
        correlationId: `worker-test-required-checks-${projectId}`,
        jobKey: `repository.required-checks-sync:${projectId}:3:policy:test`,
      },
    )
    const execution = await waitForJobExecution(database, queued.jobId, {
      timeoutMs: 20_000,
    })

    expect(execution).toMatchObject({
      taskIdentifier: 'repository.required-checks-sync',
      status: 'succeeded',
      attempts: 1,
    })
    expect(requiredCheckSyncExecutions).toContain(projectId)
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

  it('marks a delivery failed when its retained payload is unavailable', async () => {
    const deliveryId = randomUUID()
    const receivedAt = new Date()

    await database.kysely
      .insertInto('github_webhook_deliveries')
      .values({
        delivery_id: deliveryId,
        event: 'push',
        action: null,
        installation_id: null,
        repository_id: null,
        payload_hash: '0'.repeat(64),
        raw_payload: null,
        processing_state: 'queued',
        attempt_count: 0,
        error_code: null,
        received_at: receivedAt,
        processing_started_at: null,
        processed_at: null,
        raw_payload_expires_at: receivedAt,
        raw_payload_purged_at: receivedAt,
        updated_at: receivedAt,
      })
      .execute()

    const queued = await enqueueJob(
      database,
      'github_webhook_process',
      { deliveryId },
      { correlationId: `worker-test-webhook-missing-payload-${deliveryId}` },
    )
    const execution = await waitForJobExecution(database, queued.jobId, {
      timeoutMs: 20_000,
    })
    const delivery = await database.kysely
      .selectFrom('github_webhook_deliveries')
      .select(['processing_state', 'attempt_count', 'error_code'])
      .where('delivery_id', '=', deliveryId)
      .executeTakeFirstOrThrow()

    expect(execution).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: { code: 'GITHUB_WEBHOOK_PAYLOAD_UNAVAILABLE' },
    })
    expect(delivery).toEqual({
      processing_state: 'failed',
      attempt_count: 1,
      error_code: 'GITHUB_WEBHOOK_PAYLOAD_UNAVAILABLE',
    })
  })

  it('claims a webhook delivery only once across concurrent jobs', async () => {
    const deliveryId = randomUUID()
    const installationId = '9000123'
    const receivedAt = new Date()
    const payload = Buffer.from(
      JSON.stringify({
        action: 'created',
        installation: {
          id: Number(installationId),
          account: {
            id: 99,
            login: 'octocat',
            type: 'User',
            avatar_url: null,
          },
          target_type: 'User',
          repository_selection: 'selected',
          permissions: { metadata: 'read' },
          suspended_at: null,
        },
        repositories: [],
      }),
    )

    await database.kysely
      .insertInto('github_webhook_deliveries')
      .values({
        delivery_id: deliveryId,
        event: 'installation',
        action: 'created',
        installation_id: installationId,
        repository_id: null,
        payload_hash: '1'.repeat(64),
        raw_payload: payload,
        processing_state: 'queued',
        attempt_count: 0,
        error_code: null,
        received_at: receivedAt,
        processing_started_at: null,
        processed_at: null,
        raw_payload_expires_at: new Date(receivedAt.getTime() + 60_000),
        raw_payload_purged_at: null,
        updated_at: receivedAt,
      })
      .execute()

    const queued = await Promise.all([
      enqueueJob(
        database,
        'github_webhook_process',
        { deliveryId },
        {
          correlationId: `worker-test-webhook-claim-a-${deliveryId}`,
        },
      ),
      enqueueJob(
        database,
        'github_webhook_process',
        { deliveryId },
        {
          correlationId: `worker-test-webhook-claim-b-${deliveryId}`,
        },
      ),
    ])
    const executions = await Promise.all(
      queued.map((job) => waitForJobExecution(database, job.jobId, { timeoutMs: 20_000 })),
    )
    const events = await database.kysely
      .selectFrom('github_integration_events')
      .select('id')
      .where('event_type', '=', 'github.installation.created')
      .where('installation_id', '=', installationId)
      .execute()

    expect(executions.map((execution) => execution.status)).toEqual(['succeeded', 'succeeded'])
    expect(events).toHaveLength(1)
  })
})
