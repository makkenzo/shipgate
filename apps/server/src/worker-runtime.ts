import { assertDatabaseReady } from '@shipgate/database'
import { startJobWorker } from '@shipgate/jobs'

import type { ApplicationContext } from './application-context.js'
import {
  queueDueRepositoryReconciliations,
  queueRepositoryReconciliationForProject,
  recoverActiveDraftCandidateEvaluations,
  recoverRepositoryIncrementalSyncJobs,
  recoverRepositoryInitialSyncJobs,
} from './projects/index.js'
import type { StartedApplication } from './run-application.js'

export async function startWorker(context: ApplicationContext): Promise<StartedApplication> {
  await assertDatabaseReady(
    context.database.kysely,
    context.runtimeConfig.database.readinessTimeoutMs,
  )

  const recoveredRepositorySyncJobs = await recoverRepositoryInitialSyncJobs(context.database)
  const recoveredIncrementalSyncProjects = await recoverRepositoryIncrementalSyncJobs(
    context.database,
  )
  const recoveredCandidateEvaluations = await recoverActiveDraftCandidateEvaluations(
    context.database,
  )
  const recoveryReconciliations = await queueRecoveryReconciliations(
    context,
    recoveredIncrementalSyncProjects,
  )
  const periodicReconciliations = await queuePeriodicReconciliations(context)

  if (recoveredRepositorySyncJobs > 0) {
    context.logger.info(
      {
        event: 'repository.initial_sync.jobs_recovered',
        recoveredJobs: recoveredRepositorySyncJobs,
      },
      'Recovered repository synchronization jobs',
    )
  }

  if (recoveredIncrementalSyncProjects.length > 0) {
    context.logger.info(
      {
        event: 'repository.incremental_sync.jobs_recovered',
        recoveredProjects: recoveredIncrementalSyncProjects.length,
      },
      'Recovered repository incremental synchronization jobs',
    )
  }

  if (recoveredCandidateEvaluations.jobs > 0) {
    context.logger.info(
      {
        event: 'release.candidate_evaluation.jobs_recovered',
        recoveredProjects: recoveredCandidateEvaluations.projects,
        recoveredJobs: recoveredCandidateEvaluations.jobs,
      },
      'Recovered active draft candidate evaluation jobs',
    )
  }

  if (recoveryReconciliations > 0) {
    context.logger.info(
      {
        event: 'repository.reconciliation.worker_recovery_queued',
        queuedReconciliations: recoveryReconciliations,
      },
      'Queued reconciliations after incremental worker recovery',
    )
  }

  if (periodicReconciliations > 0) {
    context.logger.info(
      {
        event: 'repository.reconciliation.periodic_queued',
        queuedReconciliations: periodicReconciliations,
      },
      'Queued due periodic repository reconciliations',
    )
  }

  const worker = await startJobWorker({
    dependencies: {
      database: context.database,

      logger: context.logger,
      repositoryInitialSync: context.repositoryInitialSync,
      repositoryIncrementalSync: context.repositoryIncrementalSync,
      repositoryRequiredChecksSync: context.repositoryRequiredChecksSync,
      githubWebhookProjection: context.githubWebhookProjection,
      releaseCandidateEvaluation: context.releaseCandidateEvaluation,
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

  let stopReconciliationScheduler: (() => Promise<void>) | undefined

  try {
    context.shutdown.addHook('graphile-worker', async () => {
      await worker.stop()
    })
    stopReconciliationScheduler = startRepositoryReconciliationScheduler(context)
    context.shutdown.addHook('repository-reconciliation-scheduler', async () => {
      await stopReconciliationScheduler?.()
    })
  } catch (error) {
    await stopReconciliationScheduler?.()
    await worker.stop()

    if (!context.shutdown.isShuttingDown) {
      throw error
    }

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

async function queueRecoveryReconciliations(
  context: ApplicationContext,
  projects: readonly {
    readonly projectId: string
    readonly requestIds: readonly string[]
  }[],
): Promise<number> {
  let queued = 0

  for (const project of projects) {
    const reconciliation = await queueRepositoryReconciliationForProject(context.database, {
      projectId: project.projectId,
      reason: 'worker_recovery',
      requestedByGitHubUserId: null,
      deduplicationKey: project.requestIds.join(','),
      correlationId: `repository.reconcile:worker-recovery:${project.projectId}`,
      causationId: `worker-recovery:${project.requestIds.join(',')}`,
      triggerScope: { reasons: ['worker_recovery'] },
    })

    if (reconciliation && ['queued', 'running'].includes(reconciliation.status)) {
      queued += 1
    }
  }

  return queued
}

function queuePeriodicReconciliations(context: ApplicationContext): Promise<number> {
  return queueDueRepositoryReconciliations(context.database, {
    intervalMs: context.runtimeConfig.jobs.reconciliationIntervalMs,
  })
}

function startRepositoryReconciliationScheduler(context: ApplicationContext): () => Promise<void> {
  let activeScan: Promise<void> | undefined
  const reconciliationIntervalMs = context.runtimeConfig.jobs.reconciliationIntervalMs
  const scanIntervalMs = Math.min(reconciliationIntervalMs, 5 * 60_000)
  const scan = () => {
    if (activeScan || context.shutdown.isShuttingDown) {
      return
    }

    activeScan = queuePeriodicReconciliations(context)
      .then((queuedReconciliations) => {
        if (queuedReconciliations > 0) {
          context.logger.info(
            {
              event: 'repository.reconciliation.periodic_queued',
              queuedReconciliations,
            },
            'Queued due periodic repository reconciliations',
          )
        }
      })
      .catch((error: unknown) => {
        context.logger.error(
          {
            event: 'repository.reconciliation.scheduler_failed',
            err: error instanceof Error ? error : new Error(String(error)),
          },
          'Periodic repository reconciliation scan failed',
        )
      })
      .finally(() => {
        activeScan = undefined
      })
  }
  const timer = setInterval(scan, scanIntervalMs)

  timer.unref()

  return async () => {
    clearInterval(timer)
    await activeScan
  }
}
