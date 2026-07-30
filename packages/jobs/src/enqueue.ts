import { type DatabaseClient, withTransaction } from '@shipgate/database'
import { sql } from 'kysely'

import { createJobEnvelope } from './envelope.js'
import { toJsonValue } from './json.js'
import { type TaskInput, type TaskName, taskDefinitions } from './registry.js'
import { markJobQueued } from './store.js'

export interface EnqueueJobOptions {
  readonly correlationId: string
  readonly causationId?: string
}

export interface EnqueuedJob {
  readonly jobId: string
  readonly taskIdentifier: TaskName
  readonly correlationId: string
  readonly causationId: string | undefined
  readonly maxAttempts: number
}

export async function enqueueJob<Name extends TaskName>(
  database: DatabaseClient,
  taskName: Name,
  input: TaskInput<Name>,
  options: EnqueueJobOptions,
): Promise<EnqueuedJob> {
  const definition = taskDefinitions[taskName]

  const payload = definition.dataSchema.parse(input)

  const envelope = createJobEnvelope(payload, {
    correlationId: options.correlationId,

    ...(options.causationId !== undefined
      ? {
          causationId: options.causationId,
        }
      : {}),
  })

  const jsonEnvelope = toJsonValue(envelope)

  const maxAttempts = definition.retry.maxAttempts

  return withTransaction(
    database.kysely,
    async (transaction) => {
      const result = await sql<{
        readonly id: string
      }>`
        select (
          graphile_worker.add_job(
            identifier :=
              ${taskName}::text,

            payload :=
              ${JSON.stringify(jsonEnvelope)}::json,

            max_attempts :=
              ${maxAttempts}::smallint
          )
        ).id::text as id
      `.execute(transaction)

      const jobId = result.rows[0]?.id

      if (!jobId) {
        throw new Error('Graphile Worker did not return a job ID')
      }

      await markJobQueued(transaction, {
        jobId,
        taskIdentifier: taskName,

        correlationId: options.correlationId,

        causationId: options.causationId,

        payload: jsonEnvelope,

        maxAttempts,
      })

      return {
        jobId,
        taskIdentifier: taskName,

        correlationId: options.correlationId,

        causationId: options.causationId,

        maxAttempts,
      }
    },
    {
      operation: `jobs.enqueue:${taskName}`,
    },
  )
}
