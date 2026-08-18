import { setTimeout as delay } from 'node:timers/promises'

import type { JsonValue } from '@shipgate/database'
import { z } from 'zod'

import { PermanentJobError, RetryableJobError } from './errors.js'
import {
  processGitHubWebhookDelivery,
  purgeExpiredGitHubWebhookPayloads,
} from './github-webhook.js'
import type { JobTaskContext, JobTaskDefinition } from './types.js'

export const diagnosticJobPayloadSchema = z
  .object({
    message: z.string().trim().min(1).max(1_000),

    outcome: z.enum(['success', 'retryable-error', 'permanent-error']).default('success'),

    /*
     * Для outcome=retryable-error:
     *
     * undefined — падать всегда;
     * 1 — упасть на первой попытке, затем успешно;
     * 2 — упасть на первых двух попытках.
     */
    failUntilAttempt: z.number().int().min(1).max(10).optional(),

    delayMs: z.number().int().min(0).max(30_000).default(0),
  })
  .strict()

export type DiagnosticJobPayloadInput = z.input<typeof diagnosticJobPayloadSchema>

export type DiagnosticJobPayload = z.output<typeof diagnosticJobPayloadSchema>

export const githubWebhookProcessPayloadSchema = z
  .object({ deliveryId: z.string().uuid() })
  .strict()
export type GitHubWebhookProcessPayload = z.output<typeof githubWebhookProcessPayloadSchema>

export const githubWebhookRetentionCleanupPayloadSchema = z.object({}).strict()

export const repositoryInitialSyncPayloadSchema = z
  .object({ requestId: z.string().uuid() })
  .strict()
export type RepositoryInitialSyncJobPayload = z.output<typeof repositoryInitialSyncPayloadSchema>

export const repositoryIncrementalSyncPayloadSchema = z
  .object({ requestId: z.string().uuid() })
  .strict()
export type RepositoryIncrementalSyncJobPayload = z.output<
  typeof repositoryIncrementalSyncPayloadSchema
>

export const repositoryRequiredChecksSyncPayloadSchema = z
  .object({
    projectId: z.string().trim().min(1).max(128),
    repositoryId: z.string().regex(/^[1-9][0-9]*$/),
    configurationVersion: z.number().int().positive(),
    refreshPolicy: z.boolean(),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .optional(),
    reason: z.string().trim().min(1).max(255),
    deliveryId: z.string().uuid().optional(),
    actorGitHubUserId: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
  })
  .strict()
export type RepositoryRequiredChecksSyncJobPayload = z.output<
  typeof repositoryRequiredChecksSyncPayloadSchema
>

export const releaseCandidateEvaluationPayloadSchema = z
  .object({ requestId: z.string().uuid() })
  .strict()
export type ReleaseCandidateEvaluationJobPayload = z.output<
  typeof releaseCandidateEvaluationPayloadSchema
>

function defineTask<Schema extends z.ZodTypeAny>(
  definition: JobTaskDefinition<Schema>,
): JobTaskDefinition<Schema> {
  return definition
}

function createIncrementalSyncTask(
  syncType: 'refresh_branches' | 'refresh_change' | 'refresh_checks' | 'refresh_rules',
) {
  return async (
    payload: RepositoryIncrementalSyncJobPayload,
    context: JobTaskContext,
  ): Promise<JsonValue | undefined> => {
    if (!context.repositoryIncrementalSync) {
      throw new PermanentJobError(
        'Repository incremental synchronization handler is not configured',
        { code: 'REPOSITORY_INCREMENTAL_SYNC_HANDLER_MISSING' },
      )
    }

    return context.repositoryIncrementalSync({
      requestId: payload.requestId,
      syncType,
      jobId: context.job.id,
      attempt: context.job.attempt,
      maxAttempts: context.job.maxAttempts,
      correlationId: context.correlationId,
      causationId: context.causationId,
      signal: context.signal,
      logger: context.logger,
    })
  }
}

export const taskDefinitions = {
  'release.evaluate-candidate': defineTask({
    dataSchema: releaseCandidateEvaluationPayloadSchema,
    retry: { maxAttempts: 10 },
    async execute(payload, context) {
      if (!context.releaseCandidateEvaluation) {
        throw new PermanentJobError('Release candidate evaluation handler is not configured', {
          code: 'RELEASE_CANDIDATE_EVALUATION_HANDLER_MISSING',
        })
      }

      return context.releaseCandidateEvaluation({
        requestId: payload.requestId,
        attempt: context.job.attempt,
        maxAttempts: context.job.maxAttempts,
        correlationId: context.correlationId,
        causationId: context.causationId,
        signal: context.signal,
        logger: context.logger,
      })
    },
  }),
  'repository.refresh-branches': defineTask({
    dataSchema: repositoryIncrementalSyncPayloadSchema,
    retry: { maxAttempts: 10 },
    execute: createIncrementalSyncTask('refresh_branches'),
  }),
  'repository.refresh-change': defineTask({
    dataSchema: repositoryIncrementalSyncPayloadSchema,
    retry: { maxAttempts: 10 },
    execute: createIncrementalSyncTask('refresh_change'),
  }),
  'repository.refresh-checks': defineTask({
    dataSchema: repositoryIncrementalSyncPayloadSchema,
    retry: { maxAttempts: 10 },
    execute: createIncrementalSyncTask('refresh_checks'),
  }),
  'repository.refresh-rules': defineTask({
    dataSchema: repositoryIncrementalSyncPayloadSchema,
    retry: { maxAttempts: 10 },
    execute: createIncrementalSyncTask('refresh_rules'),
  }),
  'repository.required-checks-sync': defineTask({
    dataSchema: repositoryRequiredChecksSyncPayloadSchema,
    retry: { maxAttempts: 10 },
    async execute(payload, context) {
      if (!context.repositoryRequiredChecksSync) {
        throw new PermanentJobError('Required-check synchronization handler is not configured', {
          code: 'REQUIRED_CHECKS_SYNC_HANDLER_MISSING',
        })
      }

      return context.repositoryRequiredChecksSync({
        projectId: payload.projectId,
        repositoryId: payload.repositoryId,
        configurationVersion: payload.configurationVersion,
        refreshPolicy: payload.refreshPolicy,
        commitSha: payload.commitSha,
        reason: payload.reason,
        deliveryId: payload.deliveryId,
        actorGitHubUserId: payload.actorGitHubUserId,
        attempt: context.job.attempt,
        maxAttempts: context.job.maxAttempts,
        correlationId: context.correlationId,
        causationId: context.causationId,
        signal: context.signal,
        logger: context.logger,
      })
    },
  }),
  'repository.reconcile': defineTask({
    dataSchema: repositoryInitialSyncPayloadSchema,
    retry: { maxAttempts: 10 },
    async execute(payload, context) {
      if (!context.repositoryInitialSync) {
        throw new PermanentJobError('Repository reconciliation handler is not configured', {
          code: 'REPOSITORY_RECONCILIATION_HANDLER_MISSING',
        })
      }

      return context.repositoryInitialSync({
        requestId: payload.requestId,
        attempt: context.job.attempt,
        maxAttempts: context.job.maxAttempts,
        correlationId: context.correlationId,
        causationId: context.causationId,
        signal: context.signal,
        logger: context.logger,
      })
    },
  }),
  'repository.initial-sync': defineTask({
    dataSchema: repositoryInitialSyncPayloadSchema,
    retry: { maxAttempts: 10 },
    async execute(payload, context) {
      if (!context.repositoryInitialSync) {
        throw new PermanentJobError(
          'Repository initial synchronization handler is not configured',
          {
            code: 'REPOSITORY_INITIAL_SYNC_HANDLER_MISSING',
          },
        )
      }

      return context.repositoryInitialSync({
        requestId: payload.requestId,
        attempt: context.job.attempt,
        maxAttempts: context.job.maxAttempts,
        correlationId: context.correlationId,
        causationId: context.causationId,
        signal: context.signal,
        logger: context.logger,
      })
    },
  }),
  github_webhook_retention_cleanup: defineTask({
    dataSchema: githubWebhookRetentionCleanupPayloadSchema,
    retry: { maxAttempts: 5 },
    async execute(_payload, context) {
      return { purged: await purgeExpiredGitHubWebhookPayloads(context.database) }
    },
  }),
  github_webhook_process: defineTask({
    dataSchema: githubWebhookProcessPayloadSchema,
    retry: { maxAttempts: 10 },
    async execute(payload, context) {
      return processGitHubWebhookDelivery({
        database: context.database,
        deliveryId: payload.deliveryId,
        attempt: context.job.attempt,
        correlationId: context.correlationId,
        causationId: context.causationId,
        projection: context.githubWebhookProjection,
      })
    },
  }),
  diagnostic_echo: defineTask({
    dataSchema: diagnosticJobPayloadSchema,

    retry: {
      maxAttempts: 3,
    },

    async execute(payload: DiagnosticJobPayload, context: JobTaskContext) {
      if (payload.delayMs > 0) {
        await delay(payload.delayMs, undefined, {
          signal: context.signal,
        })
      }

      if (payload.outcome === 'permanent-error') {
        throw new PermanentJobError('Diagnostic permanent failure', {
          code: 'DIAGNOSTIC_PERMANENT_FAILURE',
        })
      }

      if (
        payload.outcome === 'retryable-error' &&
        (payload.failUntilAttempt === undefined || context.job.attempt <= payload.failUntilAttempt)
      ) {
        throw new RetryableJobError('Diagnostic retryable failure', {
          code: 'DIAGNOSTIC_RETRYABLE_FAILURE',

          details: {
            attempt: context.job.attempt,
            maxAttempts: context.job.maxAttempts,
          },
        })
      }

      return {
        echoedMessage: payload.message,
        attempt: context.job.attempt,
        completedAt: new Date().toISOString(),
      }
    },
  }),
} as const

export type TaskName = keyof typeof taskDefinitions

export type TaskInput<Name extends TaskName> = z.input<(typeof taskDefinitions)[Name]['dataSchema']>

export type TaskPayload<Name extends TaskName> = z.output<
  (typeof taskDefinitions)[Name]['dataSchema']
>

export const taskNames = Object.keys(taskDefinitions) as TaskName[]
