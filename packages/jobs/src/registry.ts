import { setTimeout as delay } from 'node:timers/promises'

import { z } from 'zod'

import { PermanentJobError, RetryableJobError } from './errors.js'
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

function defineTask<Schema extends z.ZodTypeAny>(
  definition: JobTaskDefinition<Schema>,
): JobTaskDefinition<Schema> {
  return definition
}

export const taskDefinitions = {
  github_webhook_process: defineTask({
    dataSchema: githubWebhookProcessPayloadSchema,
    retry: { maxAttempts: 10 },
    async execute(payload, context) {
      const now = new Date()
      const delivery = await context.database.kysely
        .updateTable('github_webhook_deliveries')
        .set({
          processing_state: 'processing',
          processing_started_at: now,
          attempt_count: context.job.attempt,
          error_code: null,
          updated_at: now,
        })
        .where('delivery_id', '=', payload.deliveryId)
        .where('processing_state', '!=', 'succeeded')
        .returning(['delivery_id', 'event', 'action'])
        .executeTakeFirst()
      if (!delivery) return { deliveryId: payload.deliveryId, skipped: true }

      // Event-specific dispatch is introduced by the following roadmap tasks.
      await context.database.kysely
        .updateTable('github_webhook_deliveries')
        .set({
          processing_state: 'succeeded',
          processed_at: new Date(),
          error_code: null,
          updated_at: new Date(),
        })
        .where('delivery_id', '=', payload.deliveryId)
        .execute()

      await context.database.kysely
        .updateTable('github_webhook_deliveries')
        .set({ raw_payload: null, raw_payload_purged_at: new Date(), updated_at: new Date() })
        .where('raw_payload_expires_at', '<=', new Date())
        .where('raw_payload', 'is not', null)
        .execute()

      return { deliveryId: payload.deliveryId, event: delivery.event, action: delivery.action }
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
