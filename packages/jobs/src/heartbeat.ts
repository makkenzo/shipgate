import { hostname } from 'node:os'

import type { DatabaseClient } from '@shipgate/database'

import type { StructuredLogger } from './types.js'

export interface WorkerHeartbeat {
  readonly workerId: string

  stop(): Promise<void>
}

export async function startWorkerHeartbeat(options: {
  readonly database: DatabaseClient
  readonly logger: StructuredLogger
  readonly workerId: string
  readonly appVersion: string
  readonly intervalMs: number
}): Promise<WorkerHeartbeat> {
  const startedAt = new Date()

  const logger = options.logger.child({
    workerId: options.workerId,
  })

  let heartbeatPromise = Promise.resolve()

  const writeHeartbeat = async () => {
    const now = new Date()

    await options.database.kysely
      .insertInto('shipgate_worker_heartbeat')
      .values({
        worker_id: options.workerId,
        hostname: hostname(),
        pid: process.pid,
        app_version: options.appVersion,
        started_at: startedAt,
        heartbeat_at: now,
      })
      .onConflict((conflict) =>
        conflict.column('worker_id').doUpdateSet({
          hostname: hostname(),
          pid: process.pid,

          app_version: options.appVersion,

          heartbeat_at: now,
        }),
      )
      .execute()
  }

  await writeHeartbeat()

  const timer = setInterval(() => {
    heartbeatPromise = heartbeatPromise.then(writeHeartbeat).catch((error: unknown) => {
      logger.error(
        {
          event: 'worker.heartbeat.failed',

          err: error instanceof Error ? error : new Error(String(error)),
        },
        'Worker heartbeat failed',
      )
    })
  }, options.intervalMs)

  return {
    workerId: options.workerId,

    async stop() {
      clearInterval(timer)

      await heartbeatPromise

      await options.database.kysely
        .deleteFrom('shipgate_worker_heartbeat')
        .where('worker_id', '=', options.workerId)
        .execute()
    },
  }
}

export async function isWorkerHeartbeatFresh(
  database: DatabaseClient,
  workerHostname: string,
  staleAfterMs: number,
): Promise<boolean> {
  const threshold = new Date(Date.now() - staleAfterMs)

  const heartbeat = await database.kysely
    .selectFrom('shipgate_worker_heartbeat')
    .select('worker_id')
    .where('hostname', '=', workerHostname)
    .where('heartbeat_at', '>=', threshold)
    .executeTakeFirst()

  return heartbeat !== undefined
}
