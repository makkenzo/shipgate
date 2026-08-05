import { type DatabaseClient, withTransaction } from '@shipgate/database'
import { enqueueJobInTransaction } from '@shipgate/jobs'
import type { GitHubWebhookMetadata } from './policy.js'

const retentionMs = 30 * 24 * 60 * 60 * 1_000
export type GitHubWebhookAcceptance =
  | { readonly status: 'queued'; readonly jobId: string }
  | { readonly status: 'duplicate' }
  | { readonly status: 'ignored' }
  | { readonly status: 'conflict' }
export async function acceptGitHubWebhookDelivery(input: {
  readonly database: DatabaseClient
  readonly deliveryId: string
  readonly metadata: GitHubWebhookMetadata
  readonly payloadHash: string
  readonly rawBody: Buffer
  readonly correlationId: string
}): Promise<GitHubWebhookAcceptance> {
  const receivedAt = new Date()
  return withTransaction(
    input.database.kysely,
    async (transaction) => {
      const inserted = await transaction
        .insertInto('github_webhook_deliveries')
        .values({
          delivery_id: input.deliveryId,
          event: input.metadata.event,
          action: input.metadata.action,
          installation_id: input.metadata.installationId,
          repository_id: input.metadata.repositoryId,
          payload_hash: input.payloadHash,
          raw_payload: input.rawBody,
          processing_state: input.metadata.actionSupported ? 'queued' : 'ignored',
          attempt_count: 0,
          error_code: null,
          ignored_reason: input.metadata.ignoredReason,
          received_at: receivedAt,
          processing_started_at: null,
          processed_at: input.metadata.actionSupported ? null : receivedAt,
          raw_payload_expires_at: new Date(receivedAt.getTime() + retentionMs),
          raw_payload_purged_at: null,
          updated_at: receivedAt,
        })
        .onConflict((conflict) => conflict.column('delivery_id').doNothing())
        .returning('delivery_id')
        .executeTakeFirst()
      if (inserted) {
        const job = input.metadata.actionSupported
          ? await enqueueJobInTransaction(
              transaction,
              'github_webhook_process',
              { deliveryId: input.deliveryId },
              {
                correlationId: input.correlationId,
                causationId: `github-webhook:${input.deliveryId}`,
                jobKey: `github-webhook:${input.deliveryId}`,
              },
            )
          : null
        await enqueueJobInTransaction(
          transaction,
          'github_webhook_retention_cleanup',
          {},
          {
            correlationId: input.correlationId,
            causationId: `github-webhook:${input.deliveryId}`,
            jobKey: `github-webhook-retention:${input.deliveryId}`,
            runAt: new Date(receivedAt.getTime() + retentionMs),
          },
        )
        return job ? { status: 'queued', jobId: job.jobId } : { status: 'ignored' }
      }
      const existing = await transaction
        .selectFrom('github_webhook_deliveries')
        .select('payload_hash')
        .where('delivery_id', '=', input.deliveryId)
        .executeTakeFirstOrThrow()
      return existing.payload_hash === input.payloadHash
        ? { status: 'duplicate' }
        : { status: 'conflict' }
    },
    { operation: 'github.webhook.accept' },
  )
}
