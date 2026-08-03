import type { ColumnType, Generated, Kysely } from 'kysely'
import type { Pool } from 'pg'

import type { DatabaseOperationError } from './errors.js'

export type JsonPrimitive = string | number | boolean | null

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | {
      readonly [key: string]: JsonValue
    }

export interface DatabaseSchema {
  github_user_credentials: GitHubUserCredentialTable

  github_users: GitHubUserTable

  sessions: SessionTable

  oauth_attempts: OAuthAttemptTable

  github_installations: GitHubInstallationTable

  github_installation_repositories: GitHubInstallationRepositoryTable

  github_installation_permissions: GitHubInstallationPermissionTable

  github_webhook_deliveries: GitHubWebhookDeliveryTable

  github_integration_events: GitHubIntegrationEventTable

  shipgate_job_execution: ShipgateJobExecutionTable

  shipgate_worker_heartbeat: ShipgateWorkerHeartbeatTable
}

export interface DatabasePoolOptions {
  readonly min: number
  readonly max: number
  readonly idleTimeoutMs: number
  readonly connectionTimeoutMs: number
  readonly maxLifetimeSeconds: number
}

export type DatabaseSslMode = 'disable' | 'require' | 'verify-full'

export interface CreateDatabaseOptions {
  readonly connectionString: string
  readonly applicationName: string

  readonly ssl: {
    readonly mode: DatabaseSslMode
    readonly ca?: string
  }

  readonly pool: DatabasePoolOptions

  /**
   * Для CLI и одноразовых тестовых процессов.
   * В API/worker оставляем false.
   */
  readonly allowExitOnIdle?: boolean

  readonly onPoolError: (error: DatabaseOperationError) => void
}

export interface DatabaseClient {
  readonly kysely: Kysely<DatabaseSchema>
  readonly pool: Pool

  destroy(): Promise<void>
}

export interface GitHubUserCredentialTable {
  github_user_id: string
  version: Generated<number>
  encrypted_access_token: string
  access_token_expires_at: Date
  encrypted_refresh_token: string
  refresh_token_expires_at: Date
  refresh_lease_id: string | null
  refresh_lease_expires_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface GitHubUserTable {
  github_user_id: string
  login: string
  avatar_url: string | null
  display_name: string | null
  email: string | null
  html_url: string
  installations: ColumnType<JsonValue, string, string>
  installations_synced_at: Date
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface SessionTable {
  id: string
  github_user_id: string
  token_hash: string
  csrf_token_hash: string
  expires_at: Date
  revoked_at: Date | null
  revocation_reason: string | null
  last_seen_at: Date
  user_agent: string | null
  created_at: Generated<Date>
}

export interface OAuthAttemptTable {
  id: string
  state_hash: string
  pkce_verifier: string
  return_to: string
  expires_at: Date
  consumed_at: Date | null
  created_at: Generated<Date>
}

export type GitHubInstallationPermissionState = 'current' | 'stale' | 'suspended' | 'revoked'

export type GitHubInstallationLifecycleState =
  | 'active'
  | 'suspended'
  | 'pending_deletion'
  | 'deleted'

export interface GitHubInstallationTable {
  installation_id: string
  owner_id: string
  owner_type: string
  owner_login: string
  owner_avatar_url: string | null
  repository_selection: 'all' | 'selected'
  suspended_at: Date | null
  permission_state: GitHubInstallationPermissionState
  lifecycle_state: Generated<GitHubInstallationLifecycleState>
  deletion_requested_at: Generated<Date | null>
  deleted_at: Generated<Date | null>
  last_successful_confirmation_at: Date | null
  last_reconciled_at: Date
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface GitHubInstallationRepositoryTable {
  installation_id: string
  repository_id: string
  owner_id: string
  owner_login: string
  name: string
  full_name: string
  private: boolean
  archived: boolean
  disabled: boolean
  default_branch: string | null
  visibility: string | null
  last_successful_confirmation_at: Date
  last_reconciled_at: Date
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface GitHubInstallationPermissionTable {
  installation_id: string
  permission_name: string
  permission_level: 'read' | 'write'
  last_reconciled_at: Date
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type GitHubWebhookProcessingState = 'queued' | 'processing' | 'succeeded' | 'failed'

export interface GitHubWebhookDeliveryTable {
  delivery_id: string
  event: string
  action: string | null
  installation_id: string | null
  repository_id: string | null
  payload_hash: string
  raw_payload: Buffer | null
  processing_state: GitHubWebhookProcessingState
  attempt_count: number
  error_code: string | null
  received_at: Generated<Date>
  processing_started_at: Date | null
  processed_at: Date | null
  raw_payload_expires_at: Date
  raw_payload_purged_at: Date | null
  updated_at: Generated<Date>
}

export type GitHubIntegrationEventType =
  | 'github.installation.created'
  | 'github.installation.suspended'
  | 'github.installation.unsuspended'
  | 'github.installation.permissions_changed'
  | 'github.installation.reconciliation_requested'
  | 'github.installation.deletion_requested'
  | 'github.repository.access_added'
  | 'github.repository.access_removed'
  | 'github.repository.identity_changed'
  | 'github.repository.deleted'
  | 'github.user.authorization_revoked'

export interface GitHubIntegrationEventTable {
  id: string
  event_type: GitHubIntegrationEventType
  installation_id: string | null
  repository_id: string | null
  github_user_id: string | null
  payload: JsonValue
  occurred_at: Date
  created_at: Generated<Date>
}

export type JobExecutionStatus = 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed'

export interface ShipgateJobExecutionTable {
  graphile_job_id: string
  task_identifier: string
  status: JobExecutionStatus
  correlation_id: string
  causation_id: string | null
  payload: JsonValue
  attempts: number
  max_attempts: number
  result: JsonValue | null
  last_error: JsonValue | null
  queued_at: Generated<Date>
  started_at: Date | null
  completed_at: Date | null
  updated_at: Generated<Date>
}

export interface ShipgateWorkerHeartbeatTable {
  worker_id: string
  hostname: string
  pid: number
  app_version: string
  started_at: Date
  heartbeat_at: Date
}
