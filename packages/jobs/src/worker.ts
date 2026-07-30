import { EventEmitter } from 'node:events'

import { Logger as GraphileLogger, type LogLevel, run, type WorkerEvents } from 'graphile-worker'

import { createTaskList } from './execution.js'
import { startWorkerHeartbeat, type WorkerHeartbeat } from './heartbeat.js'
import type { JobTaskDependencies, StructuredLogger } from './types.js'

export interface JobWorkerRuntime {
  readonly workerId: string
  readonly promise: Promise<void>

  stop(): Promise<void>
}

export async function startJobWorker(options: {
  readonly dependencies: JobTaskDependencies

  readonly appVersion: string
  readonly concurrency: number
  readonly pollIntervalMs: number
  readonly heartbeatIntervalMs: number
  readonly shutdownAbortTimeoutMs: number
}): Promise<JobWorkerRuntime> {
  const { dependencies } = options

  const events = new EventEmitter() as unknown as WorkerEvents

  let workerId: string | undefined

  events.once('pool:create', ({ workerPool }) => {
    workerId = workerPool.id
  })

  events.on('pool:fatalError', ({ error, action }) => {
    dependencies.logger.error(
      {
        event: 'graphile_worker.pool.fatal',

        action,

        err: error instanceof Error ? error : new Error(String(error)),
      },
      'Graphile Worker pool failed',
    )
  })

  const runner = await run({
    pgPool: dependencies.database.pool,

    taskList: createTaskList(dependencies),

    concurrency: options.concurrency,

    pollInterval: options.pollIntervalMs,

    noHandleSignals: true,

    gracefulShutdownAbortTimeout: options.shutdownAbortTimeoutMs,

    events,

    logger: createGraphileLogger(dependencies.logger),
  })

  if (!workerId) {
    await runner.stop('Worker pool ID was not captured')

    throw new Error('Graphile Worker did not emit pool:create')
  }

  let heartbeat: WorkerHeartbeat

  try {
    heartbeat = await startWorkerHeartbeat({
      database: dependencies.database,

      logger: dependencies.logger,

      workerId,

      appVersion: options.appVersion,

      intervalMs: options.heartbeatIntervalMs,
    })
  } catch (error) {
    await runner.stop('Heartbeat startup failed')

    throw error
  }

  let stopPromise: Promise<void> | undefined

  return {
    workerId,
    promise: runner.promise,

    stop() {
      stopPromise ??= (async () => {
        try {
          /*
           * Сначала перестаём брать jobs
           * и ждём выполняющиеся.
           *
           * Heartbeat продолжает работать
           * во время drain.
           */
          await runner.stop('Application shutdown')
        } finally {
          await heartbeat.stop()
        }
      })()

      return stopPromise
    },
  }
}

function createGraphileLogger(logger: StructuredLogger): GraphileLogger {
  return new GraphileLogger((scope) => (level: LogLevel, message: string, metadata?: unknown) => {
    const bindings = {
      event: 'graphile_worker.log',

      graphileWorker: {
        ...scope,

        ...(metadata !== undefined
          ? {
              metadata,
            }
          : {}),
      },
    }

    switch (level) {
      case 'error':
        logger.error(bindings, message)
        break

      case 'warning':
        logger.warn(bindings, message)
        break

      case 'info':
        logger.info(bindings, message)
        break

      case 'debug':
        logger.debug(bindings, message)
        break
    }
  })
}
