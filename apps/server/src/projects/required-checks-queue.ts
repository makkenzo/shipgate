import type { DatabaseSchema } from '@shipgate/database'
import { enqueueJobInTransaction } from '@shipgate/jobs'
import type { Transaction } from 'kysely'

export interface QueueRequiredChecksSyncInput {
  readonly transaction: Transaction<DatabaseSchema>
  readonly projectId: string
  readonly repositoryId: string
  readonly configurationVersion: number
  readonly refreshPolicy: boolean
  readonly commitSha?: string
  readonly reason: string
  readonly deliveryId?: string
  readonly actorGitHubUserId?: string
  readonly correlationId: string
  readonly causationId: string
}

export async function queueRequiredChecksSync(input: QueueRequiredChecksSyncInput): Promise<void> {
  const target = input.refreshPolicy ? 'policy' : (input.commitSha ?? 'all')
  const discriminator = input.deliveryId ?? input.actorGitHubUserId ?? 'system'

  await enqueueJobInTransaction(
    input.transaction,
    'repository.required-checks-sync',
    {
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      configurationVersion: input.configurationVersion,
      refreshPolicy: input.refreshPolicy,
      reason: input.reason,
      ...(input.commitSha !== undefined ? { commitSha: input.commitSha } : {}),
      ...(input.deliveryId !== undefined ? { deliveryId: input.deliveryId } : {}),
      ...(input.actorGitHubUserId !== undefined
        ? { actorGitHubUserId: input.actorGitHubUserId }
        : {}),
    },
    {
      correlationId: input.correlationId,
      causationId: input.causationId,
      jobKey: [
        'repository.required-checks-sync',
        input.projectId,
        input.configurationVersion,
        target,
        discriminator,
      ].join(':'),
    },
  )
}
