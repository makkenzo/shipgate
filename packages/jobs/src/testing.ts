import { randomUUID } from 'node:crypto'

import type { DatabaseClient } from '@shipgate/database'

import { createJobEnvelope } from './envelope.js'
import { executeJobAttempt, type JobAttemptResult } from './execution.js'
import { type TaskInput, type TaskName, taskDefinitions } from './registry.js'
import type { StructuredLogger } from './types.js'

const noopLogger: StructuredLogger = {
  child() {
    return noopLogger
  },

  debug() {},
  info() {},
  warn() {},
  error() {},
}

export function createNoopJobLogger(): StructuredLogger {
  return noopLogger
}

export async function executeJobSynchronously<Name extends TaskName>(options: {
  readonly database: DatabaseClient
  readonly taskName: Name
  readonly payload: TaskInput<Name>
  readonly attempt?: number
  readonly correlationId?: string
  readonly causationId?: string
  readonly logger?: StructuredLogger
  readonly signal?: AbortSignal
}): Promise<JobAttemptResult> {
  const definition = taskDefinitions[options.taskName]

  const payload = definition.dataSchema.parse(options.payload)

  const envelope = createJobEnvelope(payload, {
    correlationId: options.correlationId ?? randomUUID(),

    ...(options.causationId !== undefined
      ? {
          causationId: options.causationId,
        }
      : {}),
  })

  const attempt = options.attempt ?? 1

  return executeJobAttempt({
    taskName: options.taskName,
    rawPayload: envelope,
    jobId: `inline:${randomUUID()}`,
    attempt,

    maxAttempts: definition.retry.maxAttempts,

    signal: options.signal ?? new AbortController().signal,

    dependencies: {
      database: options.database,

      logger: options.logger ?? noopLogger,
    },

    persist: false,
  })
}
