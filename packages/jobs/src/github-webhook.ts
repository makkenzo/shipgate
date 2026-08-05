import { randomUUID } from 'node:crypto'

import type {
  DatabaseClient,
  DatabaseSchema,
  GitHubIntegrationEventType,
  JsonValue,
} from '@shipgate/database'
import type { Transaction } from 'kysely'
import { PermanentJobError } from './errors.js'
import type { GitHubWebhookProjectionHandler } from './types.js'

interface WebhookDelivery {
  readonly deliveryId: string
  readonly event: string
  readonly action: string | null
  readonly installationId: string | null
  readonly repositoryId: string | null
  readonly rawPayload: Buffer
}

type RecordValue = Readonly<Record<string, unknown>>
type GitHubWebhookTransaction = Transaction<DatabaseSchema>

export async function processGitHubWebhookDelivery(input: {
  readonly database: DatabaseClient
  readonly deliveryId: string
  readonly attempt: number
  readonly correlationId: string
  readonly causationId: string | undefined
  readonly projection: GitHubWebhookProjectionHandler | undefined
}): Promise<Readonly<Record<string, JsonValue>>> {
  let completedDelivery: WebhookDelivery | undefined

  try {
    const delivery = await loadDelivery(input.database, input.deliveryId, input.attempt)
    if (!delivery) return { deliveryId: input.deliveryId, skipped: true }

    let payload: RecordValue
    payload = parsePayload(delivery.rawPayload)
    validateEnvelope(delivery, payload)
    await input.database.kysely.transaction().execute(async (transaction) => {
      const now = new Date()
      const emit = async (
        eventType: GitHubIntegrationEventType,
        ids: { installationId?: string; repositoryId?: string; githubUserId?: string },
        eventPayload: JsonValue,
      ) => {
        await transaction
          .insertInto('github_integration_events')
          .values({
            id: randomUUID(),
            event_type: eventType,
            installation_id: ids.installationId ?? null,
            repository_id: ids.repositoryId ?? null,
            github_user_id: ids.githubUserId ?? null,
            payload: eventPayload,
            occurred_at: now,
          })
          .execute()
      }

      switch (`${delivery.event}.${delivery.action ?? ''}`) {
        case 'installation.created':
          await upsertInstallation(transaction, payload, now, 'current')
          await replacePermissions(transaction, requireRecord(payload.installation), now)
          await upsertRepositories(
            transaction,
            requireId(payload.installation, 'installation'),
            readRecordArray(payload.repositories),
            now,
          )
          await emit(
            'github.installation.created',
            { installationId: requireId(payload.installation, 'installation') },
            lifecyclePayload(delivery),
          )
          break

        case 'installation.suspend': {
          const installationId = requireId(payload.installation, 'installation')
          await upsertInstallation(transaction, payload, now, 'current')
          await replacePermissions(transaction, requireRecord(payload.installation), now)
          await transaction
            .updateTable('github_installations')
            .set({
              lifecycle_state: 'suspended',
              permission_state: 'suspended',
              suspended_at: readDate(requireRecord(payload.installation).suspended_at) ?? now,
              last_reconciled_at: now,
              updated_at: now,
            })
            .where('installation_id', '=', installationId)
            .execute()
          await emit(
            'github.installation.suspended',
            { installationId },
            lifecyclePayload(delivery),
          )
          break
        }

        case 'installation.unsuspend': {
          const installationId = requireId(payload.installation, 'installation')
          await upsertInstallation(transaction, payload, now, 'stale')
          await replacePermissions(transaction, requireRecord(payload.installation), now)
          await emit(
            'github.installation.unsuspended',
            { installationId },
            lifecyclePayload(delivery),
          )
          await emit(
            'github.installation.reconciliation_requested',
            { installationId },
            { reason: 'installation_unsuspended' },
          )
          break
        }

        case 'installation.deleted': {
          const installationId = requireId(payload.installation, 'installation')
          await upsertInstallation(transaction, payload, now, 'current')
          await transaction
            .updateTable('github_installations')
            .set({
              lifecycle_state: 'pending_deletion',
              permission_state: 'revoked',
              deletion_requested_at: now,
              last_reconciled_at: now,
              updated_at: now,
            })
            .where('installation_id', '=', installationId)
            .execute()
          await transaction
            .deleteFrom('github_installation_repositories')
            .where('installation_id', '=', installationId)
            .execute()
          await emit(
            'github.installation.deletion_requested',
            { installationId },
            lifecyclePayload(delivery),
          )
          break
        }

        case 'installation.new_permissions_accepted': {
          const installationId = requireId(payload.installation, 'installation')
          await upsertInstallation(transaction, payload, now, 'current')
          await replacePermissions(transaction, requireRecord(payload.installation), now)
          await emit(
            'github.installation.permissions_changed',
            { installationId },
            lifecyclePayload(delivery),
          )
          break
        }

        case 'installation_repositories.added': {
          const installationId = requireId(payload.installation, 'installation')
          const repositories = readRecordArray(payload.repositories_added)
          await upsertRepositories(transaction, installationId, repositories, now)
          for (const repository of repositories) {
            const repositoryId = requireId(repository, 'repository')
            await emit(
              'github.repository.access_added',
              { installationId, repositoryId },
              repositoryIdentity(repository),
            )
          }
          break
        }

        case 'installation_repositories.removed': {
          const installationId = requireId(payload.installation, 'installation')
          for (const repository of readRecordArray(payload.repositories_removed)) {
            const repositoryId = requireId(repository, 'repository')
            await transaction
              .deleteFrom('github_installation_repositories')
              .where('installation_id', '=', installationId)
              .where('repository_id', '=', repositoryId)
              .execute()
            await emit(
              'github.repository.access_removed',
              { installationId, repositoryId },
              repositoryIdentity(repository),
            )
          }
          break
        }

        case 'repository.renamed':
        case 'repository.transferred': {
          const installationId = requireId(payload.installation, 'installation')
          const repository = requireRecord(payload.repository)
          await upsertRepositories(transaction, installationId, [repository], now)
          await emit(
            'github.repository.identity_changed',
            { installationId, repositoryId: requireId(repository, 'repository') },
            repositoryIdentity(repository),
          )
          break
        }

        case 'repository.deleted': {
          const installationId = requireId(payload.installation, 'installation')
          const repositoryId = requireId(payload.repository, 'repository')
          await transaction
            .deleteFrom('github_installation_repositories')
            .where('installation_id', '=', installationId)
            .where('repository_id', '=', repositoryId)
            .execute()
          await emit(
            'github.repository.deleted',
            { installationId, repositoryId },
            lifecyclePayload(delivery),
          )
          break
        }

        case 'github_app_authorization.revoked': {
          const userId = requireId(payload.sender, 'sender')
          await transaction
            .deleteFrom('github_user_credentials')
            .where('github_user_id', '=', userId)
            .execute()
          await emit(
            'github.user.authorization_revoked',
            { githubUserId: userId },
            lifecyclePayload(delivery),
          )
          break
        }

        default:
          break
      }

      if (input.projection) {
        await input.projection({
          transaction,
          deliveryId: delivery.deliveryId,
          event: delivery.event,
          action: delivery.action,
          installationId: delivery.installationId,
          repositoryId: delivery.repositoryId,
          payload: payload as unknown as JsonValue,
          correlationId: input.correlationId,
          causationId: input.causationId,
        })
      }

      await transaction
        .updateTable('github_webhook_deliveries')
        .set({
          processing_state: 'succeeded',
          processed_at: now,
          error_code: null,
          ignored_reason: null,
          updated_at: now,
        })
        .where('delivery_id', '=', delivery.deliveryId)
        .execute()
    })

    completedDelivery = delivery
  } catch (error) {
    await input.database.kysely
      .updateTable('github_webhook_deliveries')
      .set({
        processing_state: 'failed',
        error_code:
          error instanceof PermanentJobError ? error.code : 'GITHUB_WEBHOOK_PROCESSING_FAILED',
        ignored_reason: null,
        updated_at: new Date(),
      })
      .where('delivery_id', '=', input.deliveryId)
      .execute()
    throw error
  }

  await purgeExpiredGitHubWebhookPayloads(input.database)

  if (!completedDelivery) {
    throw new Error('GitHub webhook delivery completed without a claimed payload')
  }

  return {
    deliveryId: completedDelivery.deliveryId,
    event: completedDelivery.event,
    action: completedDelivery.action,
  }
}

export async function purgeExpiredGitHubWebhookPayloads(
  database: DatabaseClient,
  now = new Date(),
): Promise<number> {
  const purged = await database.kysely
    .updateTable('github_webhook_deliveries')
    .set({ raw_payload: null, raw_payload_purged_at: now, updated_at: now })
    .where('raw_payload_expires_at', '<=', now)
    .where('raw_payload', 'is not', null)
    .returning('delivery_id')
    .execute()

  return purged.length
}

async function loadDelivery(
  database: DatabaseClient,
  deliveryId: string,
  attempt: number,
): Promise<WebhookDelivery | undefined> {
  const now = new Date()
  const row = await database.kysely
    .updateTable('github_webhook_deliveries')
    .set({
      processing_state: 'processing',
      processing_started_at: now,
      attempt_count: attempt,
      error_code: null,
      updated_at: now,
    })
    .where('delivery_id', '=', deliveryId)
    .where('processing_state', 'not in', ['succeeded', 'ignored'])
    .where('attempt_count', '<', attempt)
    .returning([
      'delivery_id',
      'event',
      'action',
      'installation_id',
      'repository_id',
      'raw_payload',
    ])
    .executeTakeFirst()

  if (!row) return undefined
  if (!row.raw_payload) {
    throw new PermanentJobError('GitHub webhook raw payload is unavailable', {
      code: 'GITHUB_WEBHOOK_PAYLOAD_UNAVAILABLE',
    })
  }

  return {
    deliveryId: row.delivery_id,
    event: row.event,
    action: row.action,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    rawPayload: row.raw_payload,
  }
}

function parsePayload(rawPayload: Buffer): RecordValue {
  try {
    return requireRecord(JSON.parse(rawPayload.toString('utf8')))
  } catch (cause) {
    throw new PermanentJobError('GitHub webhook payload is not valid JSON', {
      code: 'INVALID_GITHUB_WEBHOOK_PAYLOAD',
      cause,
    })
  }
}

function validateEnvelope(delivery: WebhookDelivery, payload: RecordValue): void {
  const installationId = readOptionalId(payload.installation)
  const repositoryId = readOptionalId(payload.repository)
  if (installationId !== delivery.installationId || repositoryId !== delivery.repositoryId) {
    throw new PermanentJobError('GitHub webhook envelope identity does not match the payload', {
      code: 'GITHUB_WEBHOOK_ENVELOPE_MISMATCH',
      details: {
        deliveryInstallationId: delivery.installationId,
        payloadInstallationId: installationId,
        deliveryRepositoryId: delivery.repositoryId,
        payloadRepositoryId: repositoryId,
      },
    })
  }
}

async function upsertInstallation(
  transaction: GitHubWebhookTransaction,
  payload: RecordValue,
  now: Date,
  permissionState: 'current' | 'stale',
): Promise<void> {
  const installation = requireRecord(payload.installation)
  const account = requireRecord(installation.account)
  const installationId = requireId(installation, 'installation')
  const repositorySelection = installation.repository_selection
  if (repositorySelection !== 'all' && repositorySelection !== 'selected')
    invalid('repository_selection')
  const suspendedAt = readDate(installation.suspended_at)
  const lifecycleState = suspendedAt ? 'suspended' : 'active'

  await transaction
    .insertInto('github_installations')
    .values({
      installation_id: installationId,
      owner_id: requireId(account, 'account'),
      owner_type: requireString(installation.target_type ?? account.type, 'owner type'),
      owner_login: requireString(account.login, 'owner login'),
      owner_avatar_url: readNullableString(account.avatar_url),
      repository_selection: repositorySelection,
      suspended_at: suspendedAt,
      permission_state: suspendedAt ? 'suspended' : permissionState,
      lifecycle_state: lifecycleState,
      deletion_requested_at: null,
      deleted_at: null,
      last_successful_confirmation_at: now,
      last_reconciled_at: now,
      updated_at: now,
    })
    .onConflict((conflict) =>
      conflict.column('installation_id').doUpdateSet({
        owner_id: requireId(account, 'account'),
        owner_type: requireString(installation.target_type ?? account.type, 'owner type'),
        owner_login: requireString(account.login, 'owner login'),
        owner_avatar_url: readNullableString(account.avatar_url),
        repository_selection: repositorySelection,
        suspended_at: suspendedAt,
        permission_state: suspendedAt ? 'suspended' : permissionState,
        lifecycle_state: lifecycleState,
        deletion_requested_at: null,
        deleted_at: null,
        last_successful_confirmation_at: now,
        last_reconciled_at: now,
        updated_at: now,
      }),
    )
    .execute()
}

async function replacePermissions(
  transaction: GitHubWebhookTransaction,
  installation: RecordValue,
  now: Date,
): Promise<void> {
  const installationId = requireId(installation, 'installation')
  const permissions = requireRecord(installation.permissions)
  await transaction
    .deleteFrom('github_installation_permissions')
    .where('installation_id', '=', installationId)
    .execute()
  const rows: Array<{
    readonly installation_id: string
    readonly permission_name: string
    readonly permission_level: 'read' | 'write'
    readonly last_reconciled_at: Date
    readonly updated_at: Date
  }> = Object.entries(permissions).map(([permissionName, level]) => {
    if (level !== 'read' && level !== 'write') invalid(`permission ${permissionName}`)

    return {
      installation_id: installationId,
      permission_name: permissionName,
      permission_level: level,
      last_reconciled_at: now,
      updated_at: now,
    }
  })
  if (rows.length)
    await transaction.insertInto('github_installation_permissions').values(rows).execute()
}

async function upsertRepositories(
  transaction: GitHubWebhookTransaction,
  installationId: string,
  repositories: readonly RecordValue[],
  now: Date,
): Promise<void> {
  for (const repository of repositories) {
    const owner = requireRecord(repository.owner)
    const values = {
      installation_id: installationId,
      repository_id: requireId(repository, 'repository'),
      owner_id: requireId(owner, 'repository owner'),
      owner_login: requireString(owner.login, 'repository owner login'),
      name: requireString(repository.name, 'repository name'),
      full_name: requireString(repository.full_name, 'repository full name'),
      private: requireBoolean(repository.private, 'repository private'),
      archived: repository.archived === true,
      disabled: repository.disabled === true,
      default_branch: readNullableString(repository.default_branch),
      visibility: readNullableString(repository.visibility),
      last_successful_confirmation_at: now,
      last_reconciled_at: now,
      updated_at: now,
    }
    await transaction
      .insertInto('github_installation_repositories')
      .values(values)
      .onConflict((conflict) =>
        conflict.columns(['installation_id', 'repository_id']).doUpdateSet(values),
      )
      .execute()
  }
}

function lifecyclePayload(delivery: WebhookDelivery): JsonValue {
  return { deliveryId: delivery.deliveryId, event: delivery.event, action: delivery.action }
}

function repositoryIdentity(repository: RecordValue): JsonValue {
  const owner = requireRecord(repository.owner)
  return {
    id: requireId(repository, 'repository'),
    ownerId: requireId(owner, 'repository owner'),
    ownerLogin: requireString(owner.login, 'repository owner login'),
    name: requireString(repository.name, 'repository name'),
    fullName: requireString(repository.full_name, 'repository full name'),
  }
}

function readRecordArray(value: unknown): readonly RecordValue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid('repository list')
  return value.map(requireRecord)
}

function requireRecord(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('object')
  return value as RecordValue
}

function readOptionalId(value: unknown): string | null {
  if (value == null) return null
  return requireId(value, 'identity')
}

function requireId(value: unknown, name: string): string {
  const record = requireRecord(value)
  const id = record.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) invalid(`${name} id`)
  return String(id)
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(name)
  return value
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') invalid(name)
  return value
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readDate(value: unknown): Date | null {
  if (value == null) return null
  if (typeof value !== 'string') invalid('date')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) invalid('date')
  return date
}

function invalid(name: string): never {
  throw new PermanentJobError(`GitHub webhook payload has invalid ${name}`, {
    code: 'INVALID_GITHUB_WEBHOOK_PAYLOAD',
  })
}
