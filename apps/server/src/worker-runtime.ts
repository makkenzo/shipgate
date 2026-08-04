import { assertDatabaseReady } from '@shipgate/database'
import { startJobWorker } from '@shipgate/jobs'

import type { ApplicationContext } from './application-context.js'
import { recoverRepositoryInitialSyncJobs } from './projects/index.js'
import type { StartedApplication } from './run-application.js'

export async function startWorker(context: ApplicationContext): Promise<StartedApplication> {
  await assertDatabaseReady(
    context.database.kysely,
    context.runtimeConfig.database.readinessTimeoutMs,
  )

  const recoveredRepositorySyncJobs = await recoverRepositoryInitialSyncJobs(context.database)

  if (recoveredRepositorySyncJobs > 0) {
    context.logger.info(
      {
        event: 'repository.initial_sync.jobs_recovered',
        recoveredJobs: recoveredRepositorySyncJobs,
      },
      'Recovered repository synchronization jobs',
    )
  }

  const worker = await startJobWorker({
    dependencies: {
      database: context.database,

      logger: context.logger,
      repositoryInitialSync: context.repositoryInitialSync,
    },

    appVersion: context.runtimeConfig.appVersion,

    concurrency: context.runtimeConfig.jobs.concurrency,

    pollIntervalMs: context.runtimeConfig.jobs.pollIntervalMs,

    heartbeatIntervalMs: context.runtimeConfig.jobs.heartbeatIntervalMs,

    shutdownAbortTimeoutMs: Math.min(5_000, context.runtimeConfig.shutdownTimeoutMs),
  })

  if (context.shutdown.isShuttingDown) {
    await worker.stop()

    return {
      waitUntilStopped: worker.promise,
    }
  }

  try {
    context.shutdown.addHook('graphile-worker', async () => {
      await worker.stop()
    })
  } catch (error) {
    if (!context.shutdown.isShuttingDown) {
      throw error
    }

    await worker.stop()

    return {
      waitUntilStopped: worker.promise,
    }
  }

  return {
    startupFields: {
      worker: {
        state: 'ready',
        workerId: worker.workerId,

        concurrency: context.runtimeConfig.jobs.concurrency,
      },

      database: {
        state: 'ready',
      },
    },

    waitUntilStopped: worker.promise,
  }
}
