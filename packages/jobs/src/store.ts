import { setTimeout as delay } from 'node:timers/promises'
import type {
  DatabaseClient,
  DatabaseSchema,
  JobExecutionStatus,
  JsonValue,
} from '@shipgate/database'
import { type Kysely, sql } from 'kysely'

export interface JobExecutionRecord {
  readonly jobId: string
  readonly taskIdentifier: string
  readonly status: JobExecutionStatus
  readonly correlationId: string
  readonly causationId: string | null
  readonly payload: JsonValue
  readonly attempts: number
  readonly maxAttempts: number
  readonly result: JsonValue | null
  readonly lastError: JsonValue | null
  readonly queuedAt: Date
  readonly startedAt: Date | null
  readonly completedAt: Date | null
  readonly updatedAt: Date
}

interface MarkJobQueuedInput {
  readonly jobId: string
  readonly taskIdentifier: string
  readonly correlationId: string
  readonly causationId: string | undefined
  readonly payload: JsonValue
  readonly maxAttempts: number
}

export async function markJobQueued(
  database: Kysely<DatabaseSchema>,
  input: MarkJobQueuedInput,
): Promise<void> {
  await database
    .insertInto('shipgate_job_execution')
    .values({
      graphile_job_id: input.jobId,
      task_identifier: input.taskIdentifier,
      status: 'queued',
      correlation_id: input.correlationId,
      causation_id: input.causationId ?? null,
      payload: input.payload,
      attempts: 0,
      max_attempts: input.maxAttempts,
      result: null,
      last_error: null,
      started_at: null,
      completed_at: null,
    })
    .onConflict((conflict) =>
      conflict.column('graphile_job_id').doUpdateSet({
        task_identifier: input.taskIdentifier,

        status: 'queued',

        correlation_id: input.correlationId,

        causation_id: input.causationId ?? null,

        payload: input.payload,

        attempts: 0,

        max_attempts: input.maxAttempts,

        result: null,
        last_error: null,
        started_at: null,
        completed_at: null,

        queued_at: sql`now()`,
        updated_at: sql`now()`,
      }),
    )
    .execute()
}

interface MarkJobStartedInput {
  readonly jobId: string
  readonly taskIdentifier: string
  readonly correlationId: string
  readonly causationId: string | undefined
  readonly payload: JsonValue
  readonly attempt: number
  readonly maxAttempts: number
}

export async function markJobStarted(
  database: Kysely<DatabaseSchema>,
  input: MarkJobStartedInput,
): Promise<void> {
  await database
    .insertInto('shipgate_job_execution')
    .values({
      graphile_job_id: input.jobId,
      task_identifier: input.taskIdentifier,
      status: 'running',
      correlation_id: input.correlationId,
      causation_id: input.causationId ?? null,
      payload: input.payload,
      attempts: input.attempt,
      max_attempts: input.maxAttempts,
      result: null,
      last_error: null,
      started_at: new Date(),
      completed_at: null,
    })
    .onConflict((conflict) =>
      conflict.column('graphile_job_id').doUpdateSet({
        status: 'running',
        attempts: input.attempt,

        started_at: sql`
            coalesce(
              shipgate_job_execution.started_at,
              now()
            )
          `,

        completed_at: null,
        updated_at: sql`now()`,
      }),
    )
    .execute()
}

export async function markJobSucceeded(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly jobId: string
    readonly attempt: number
    readonly result: JsonValue | null
  },
): Promise<void> {
  await database
    .updateTable('shipgate_job_execution')
    .set({
      status: 'succeeded',
      attempts: input.attempt,
      result: input.result,
      last_error: null,
      completed_at: new Date(),
      updated_at: new Date(),
    })
    .where('graphile_job_id', '=', input.jobId)
    .execute()
}

export async function markJobFailed(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly jobId: string
    readonly status: 'retrying' | 'failed'
    readonly attempt: number
    readonly error: JsonValue
  },
): Promise<void> {
  await database
    .updateTable('shipgate_job_execution')
    .set({
      status: input.status,
      attempts: input.attempt,
      last_error: input.error,

      completed_at: input.status === 'failed' ? new Date() : null,

      updated_at: new Date(),
    })
    .where('graphile_job_id', '=', input.jobId)
    .execute()
}

export async function getJobExecution(
  database: DatabaseClient,
  jobId: string,
): Promise<JobExecutionRecord | undefined> {
  const row = await database.kysely
    .selectFrom('shipgate_job_execution')
    .selectAll()
    .where('graphile_job_id', '=', jobId)
    .executeTakeFirst()

  if (!row) {
    return undefined
  }

  return {
    jobId: row.graphile_job_id,
    taskIdentifier: row.task_identifier,
    status: row.status,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    result: row.result,
    lastError: row.last_error,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  }
}

export async function waitForJobExecution(
  database: DatabaseClient,
  jobId: string,
  options: {
    readonly timeoutMs?: number
    readonly intervalMs?: number
    readonly signal?: AbortSignal
  } = {},
): Promise<JobExecutionRecord> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 30_000)

  const signal =
    options.signal !== undefined ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal

  const intervalMs = options.intervalMs ?? 100

  while (true) {
    signal.throwIfAborted()

    const execution = await getJobExecution(database, jobId)

    if (execution?.status === 'succeeded' || execution?.status === 'failed') {
      return execution
    }

    await delay(intervalMs, undefined, {
      signal,
    })
  }
}
