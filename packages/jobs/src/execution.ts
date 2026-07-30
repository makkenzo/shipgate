import { performance } from 'node:perf_hooks'
import type { JsonValue } from '@shipgate/database'
import type { Task, TaskList } from 'graphile-worker'
import type { z } from 'zod'
import { createJobEnvelopeSchema } from './envelope.js'
import { PermanentJobError } from './errors.js'
import { type TaskName, taskDefinitions } from './registry.js'
import { markJobFailed, markJobStarted, markJobSucceeded } from './store.js'
import type { JobTaskDefinition, JobTaskDependencies } from './types.js'

type UntypedTaskDefinition = JobTaskDefinition<z.ZodTypeAny>

export interface JobAttemptResult {
  readonly status: 'succeeded' | 'retrying' | 'failed'

  readonly shouldThrow: boolean
  readonly result: JsonValue | undefined
  readonly error: Error | undefined
}

interface ExecuteJobAttemptOptions {
  readonly taskName: TaskName
  readonly rawPayload: unknown
  readonly jobId: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly signal: AbortSignal
  readonly dependencies: JobTaskDependencies
  readonly persist: boolean
}

export function createTaskList(dependencies: JobTaskDependencies): TaskList {
  return {
    diagnostic_echo: createTaskExecutor('diagnostic_echo', dependencies),
  }
}

function createTaskExecutor<Name extends TaskName>(
  taskName: Name,
  dependencies: JobTaskDependencies,
): Task<Name> {
  return async (payload, helpers) => {
    const result = await executeJobAttempt({
      taskName,
      rawPayload: payload,
      jobId: helpers.job.id,
      attempt: helpers.job.attempts,
      maxAttempts: helpers.job.max_attempts,

      signal: helpers.abortSignal,
      dependencies,
      persist: true,
    })

    if (result.shouldThrow && result.error !== undefined) {
      throw result.error
    }
  }
}

export async function executeJobAttempt(
  options: ExecuteJobAttemptOptions,
): Promise<JobAttemptResult> {
  const { taskName, jobId, attempt, maxAttempts, dependencies, persist } = options

  const definition = taskDefinitions[taskName] as UntypedTaskDefinition

  const envelopeResult = createJobEnvelopeSchema(definition.dataSchema).safeParse(
    options.rawPayload,
  )

  const correlationId = envelopeResult.success
    ? envelopeResult.data.metadata.correlationId
    : `job:${jobId}`

  const causationId = envelopeResult.success ? envelopeResult.data.metadata.causationId : undefined

  const logger = dependencies.logger.child({
    correlationId,

    ...(causationId !== undefined
      ? {
          causationId,
        }
      : {}),

    jobId,
    taskIdentifier: taskName,
    attempt,
    maxAttempts,
  })

  const payloadForStore = envelopeResult.success ? (envelopeResult.data as JsonValue) : null

  if (persist) {
    await markJobStarted(dependencies.database.kysely, {
      jobId,
      taskIdentifier: taskName,
      correlationId,
      causationId,
      payload: payloadForStore,
      attempt,
      maxAttempts,
    })
  }

  logger.info(
    {
      event: 'job.started',
    },
    'Job started',
  )

  const startedAt = performance.now()

  if (!envelopeResult.success) {
    const error = new PermanentJobError('Invalid job payload', {
      code: 'INVALID_JOB_PAYLOAD',

      details: {
        issues: envelopeResult.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),

          code: issue.code,
          message: issue.message,
        })),
      },
    })

    if (persist) {
      await markJobFailed(dependencies.database.kysely, {
        jobId,
        status: 'failed',
        attempt,
        error: serializeJobError(error),
      })
    }

    logger.error(
      {
        event: 'job.failed',
        failureKind: 'permanent',
        err: error,
      },
      'Job payload is invalid',
    )

    return {
      status: 'failed',
      shouldThrow: false,
      result: undefined,
      error,
    }
  }

  try {
    const result = await definition.execute(envelopeResult.data.data, {
      database: dependencies.database,

      logger,

      job: {
        id: jobId,
        taskIdentifier: taskName,
        attempt,
        maxAttempts,
      },

      correlationId,
      causationId,
      signal: options.signal,
    })

    if (persist) {
      await markJobSucceeded(dependencies.database.kysely, {
        jobId,
        attempt,
        result: result ?? null,
      })
    }

    logger.info(
      {
        event: 'job.succeeded',

        durationMs: getDurationMs(startedAt),
      },
      'Job succeeded',
    )

    return {
      status: 'succeeded',
      shouldThrow: false,
      result,
      error: undefined,
    }
  } catch (value) {
    const error = toError(value)

    if (error instanceof PermanentJobError) {
      if (persist) {
        await markJobFailed(dependencies.database.kysely, {
          jobId,
          status: 'failed',
          attempt,
          error: serializeJobError(error),
        })
      }

      logger.error(
        {
          event: 'job.failed',
          failureKind: 'permanent',
          durationMs: getDurationMs(startedAt),
          err: error,
        },
        'Job failed permanently',
      )

      /*
       * Graphile Worker не имеет публичного API,
       * позволяющего текущей locked job сразу
       * перейти в permanent failed.
       *
       * Поэтому фиксируем failed в нашей
       * shadow-таблице и acknowledge-им job.
       */
      return {
        status: 'failed',
        shouldThrow: false,
        result: undefined,
        error,
      }
    }

    const exhausted = attempt >= maxAttempts

    const status = exhausted ? 'failed' : 'retrying'

    if (persist) {
      await markJobFailed(dependencies.database.kysely, {
        jobId,
        status,
        attempt,
        error: serializeJobError(error),
      })
    }

    logger[exhausted ? 'error' : 'warn'](
      {
        event: exhausted ? 'job.failed' : 'job.retrying',

        failureKind: 'retryable',
        durationMs: getDurationMs(startedAt),
        err: error,
      },
      exhausted ? 'Job exhausted retries' : 'Job will be retried',
    )

    return {
      status,
      shouldThrow: true,
      result: undefined,
      error,
    }
  }
}

function serializeJobError(error: Error): JsonValue {
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined

  const details = 'details' in error ? error.details : undefined

  return {
    name: error.name,
    message: error.message,

    ...(code !== undefined
      ? {
          code,
        }
      : {}),

    ...(isJsonValue(details)
      ? {
          details,
        }
      : {}),
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value).every(isJsonValue)
  }

  return false
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function getDurationMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}
