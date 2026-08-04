import { setTimeout as delay } from 'node:timers/promises'

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

function defineTask<Schema extends z.ZodTypeAny>(
  definition: JobTaskDefinition<Schema>,
): JobTaskDefinition<Schema> {
  return definition
}

export const taskDefinitions = {
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
