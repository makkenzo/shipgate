import type { DatabaseClient } from '@shipgate/database'
import { sql } from 'kysely'

import { taskNames } from './registry.js'

export interface QueueMetrics {
  readonly generatedAt: string

  readonly queue: {
    readonly queued: number
    readonly scheduled: number
    readonly running: number
    readonly retrying: number
    readonly failed: number
    readonly total: number
    readonly oldestQueuedAt: Date | null
  }

  readonly workers: {
    readonly active: number
    readonly stale: number
  }
}

export async function getQueueMetrics(
  database: DatabaseClient,
  heartbeatStaleAfterMs: number,
): Promise<QueueMetrics> {
  const identifiers = sql.join(
    taskNames.map((taskName) => sql`${taskName}`),
    sql`, `,
  )

  const queueResult = await sql<{
    readonly queued: number
    readonly scheduled: number
    readonly running: number
    readonly retrying: number
    readonly failed: number
    readonly total: number
    readonly oldest_queued_at: Date | null
  }>`
    select
      count(*) filter (
        where
          locked_at is null
          and attempts = 0
          and run_at <= now()
      )::integer as queued,

      count(*) filter (
        where
          locked_at is null
          and attempts = 0
          and run_at > now()
      )::integer as scheduled,

      count(*) filter (
        where locked_at is not null
      )::integer as running,

      count(*) filter (
        where
          locked_at is null
          and attempts > 0
          and attempts < max_attempts
      )::integer as retrying,

      count(*) filter (
        where attempts >= max_attempts
      )::integer as failed,

      count(*)::integer as total,

      min(created_at) filter (
        where
          locked_at is null
          and attempts < max_attempts
      ) as oldest_queued_at

    from graphile_worker.jobs

    where task_identifier = any(
      array[${identifiers}]::text[]
    )
  `.execute(database.kysely)

  const workerResult = await sql<{
    readonly active: number
    readonly stale: number
  }>`
    select
      count(*) filter (
        where heartbeat_at >=
          now() -
          (
            ${heartbeatStaleAfterMs} *
            interval '1 millisecond'
          )
      )::integer as active,

      count(*) filter (
        where heartbeat_at <
          now() -
          (
            ${heartbeatStaleAfterMs} *
            interval '1 millisecond'
          )
      )::integer as stale

    from shipgate_worker_heartbeat
  `.execute(database.kysely)

  const queue = queueResult.rows[0]
  const workers = workerResult.rows[0]

  if (!queue || !workers) {
    throw new Error('Queue metrics query returned no result')
  }

  return {
    generatedAt: new Date().toISOString(),

    queue: {
      queued: queue.queued,
      scheduled: queue.scheduled,
      running: queue.running,
      retrying: queue.retrying,
      failed: queue.failed,
      total: queue.total,
      oldestQueuedAt: queue.oldest_queued_at,
    },

    workers: {
      active: workers.active,
      stale: workers.stale,
    },
  }
}
