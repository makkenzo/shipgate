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

  github_user_installations: GitHubUserInstallationTable

  github_user_installation_repositories: GitHubUserInstallationRepositoryTable

  github_webhook_deliveries: GitHubWebhookDeliveryTable

  github_integration_events: GitHubIntegrationEventTable

  projects: ProjectTable

  repository_branches: RepositoryBranchTable

  repository_commits: RepositoryCommitTable

  changes: ChangeTable

  change_commits: ChangeCommitTable

  required_checks: RequiredCheckTable

  commit_check_results: CommitCheckResultTable

  repository_sync_runs: RepositorySyncRunTable

  repository_sync_issues: RepositorySyncIssueTable

  project_audit_events: ProjectAuditEventTable

  repository_reconciliation_requests: RepositoryReconciliationRequestTable

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

export type GitHubRepositoryPermission = 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin'

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

export interface GitHubUserInstallationTable {
  github_user_id: string
  installation_id: string
  last_reconciled_at: Date
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface GitHubUserInstallationRepositoryTable {
  github_user_id: string
  installation_id: string
  repository_id: string
  repository_permission: Exclude<GitHubRepositoryPermission, 'none'>
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

export type ProjectStatus =
  | 'initializing'
  | 'active'
  | 'degraded'
  | 'disconnected'
  | 'pending_deletion'
  | 'deleted'

export interface ProjectTable {
  id: string
  installation_id: string
  repository_id: string
  owner_id: string
  owner_login: string
  repository_name: string
  repository_full_name: string
  default_branch: string | null
  source_branch: string
  production_branch: string
  status: Generated<ProjectStatus>
  source_sha: string | null
  production_sha: string | null
  last_successful_sync_at: Date | null
  merge_base_sha: Generated<string | null>
  configuration_version: Generated<number>
  deletion_requested_at: Date | null
  deleted_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface RepositoryBranchTable {
  project_id: string
  repository_id: string
  name: string
  head_sha: string
  protected: Generated<boolean>
  default_branch: Generated<boolean>
  observed_at: Date
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface RepositoryCommitTable {
  project_id: string
  repository_id: string
  sha: string
  tree_sha: string | null
  message: string
  author_id: string | null
  author_login: string | null
  author_name: string | null
  author_email: string | null
  committer_id: string | null
  committer_login: string | null
  authored_at: Date | null
  committed_at: Date
  parent_shas: ColumnType<JsonValue, string, string>
  source_delta_position: number | null
  first_parent_position: Generated<number | null>
  integration_point_sha: Generated<string | null>
  production_patch_equivalent: Generated<boolean>
  attribution_state: Generated<CommitAttributionState>
  observed_at: Date
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type CommitAttributionState = 'managed' | 'unmanaged' | 'ambiguous'

export type ChangeMergeMethod = 'merge' | 'squash' | 'rebase' | 'unknown'

export type ChangeSynchronizationState = 'known' | 'unknown'

export type ChangeProductionPresence = 'unreleased' | 'partially_present' | 'released' | 'unknown'

export interface ChangeTable {
  id: string
  project_id: string
  repository_id: string
  github_pull_request_id: string
  pull_request_number: number
  title: string
  url: string | null
  author_id: string | null
  author_login: string | null
  base_branch: string
  merged_at: Date
  final_head_sha: string
  merge_commit_sha: string | null
  source_integration_sha: string | null
  integration_first_parent_sha: Generated<string | null>
  integration_second_parent_sha: Generated<string | null>
  merge_method: ChangeMergeMethod
  commit_set_fingerprint: string | null
  synchronization_state: ChangeSynchronizationState
  production_presence: ChangeProductionPresence
  observed_at: Date
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface ChangeCommitTable {
  project_id: string
  repository_id: string
  change_id: string
  commit_sha: string
  position: number
  created_at: Generated<Date>
}

export type RequiredCheckType = 'check_run' | 'commit_status'

export type RequiredCheckSource = 'branch_protection' | 'repository_ruleset'

export interface RequiredCheckTable {
  id: string
  project_id: string
  repository_id: string
  policy_version: number
  check_type: RequiredCheckType
  context: string
  integration_id: string | null
  source: RequiredCheckSource
  source_reference: string | null
  observed_at: Date
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type CommitCheckStatus = 'queued' | 'in_progress' | 'pending' | 'completed'

export type CommitCheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'stale'
  | 'startup_failure'
  | 'error'

export interface CommitCheckResultTable {
  id: string
  project_id: string
  repository_id: string
  commit_sha: string
  check_type: RequiredCheckType
  context: string
  integration_id: string | null
  github_object_id: string
  attempt: number | null
  status: CommitCheckStatus
  conclusion: CommitCheckConclusion | null
  details_url: string | null
  started_at: Date | null
  completed_at: Date | null
  observed_at: Date
  created_at: Generated<Date>
}

export type RepositorySyncRunStatus = 'queued' | 'running' | 'succeeded' | 'superseded' | 'failed'

export interface RepositorySyncRunTable {
  id: string
  project_id: string
  repository_id: string
  reason: string
  status: RepositorySyncRunStatus
  configuration_version: number
  idempotency_key: string
  projection_fingerprint: string | null
  source_sha: string | null
  production_sha: string | null
  started_at: Date
  completed_at: Date | null
  error_code: string | null
  error_message: string | null
  created_at: Generated<Date>
}

export type RepositorySyncIssueSeverity = 'warning' | 'error'

export type RepositorySyncIssueScope = 'repository' | 'branch' | 'change' | 'commit' | 'check'

export interface RepositorySyncIssueTable {
  id: string
  sync_run_id: string
  project_id: string
  repository_id: string
  severity: RepositorySyncIssueSeverity
  code: string
  scope: RepositorySyncIssueScope
  subject_id: string | null
  message: string
  details: ColumnType<JsonValue, string, string>
  created_at: Generated<Date>
}

export type ProjectAuditEventType =
  | 'project_created'
  | 'project_configuration_changed'
  | 'project_deletion_requested'

export type ProjectAuditSource = 'user' | 'system' | 'reconciliation'

export interface ProjectAuditEventTable {
  id: string
  project_id: string
  repository_id: string
  actor_github_user_id: string | null
  event_type: ProjectAuditEventType
  source: ProjectAuditSource
  configuration_version: number
  payload: ColumnType<JsonValue, string, string>
  occurred_at: Date
  created_at: Generated<Date>
}

export type RepositoryReconciliationMode = 'full'

export type RepositoryReconciliationRequestStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'superseded'
  | 'failed'
  | 'cancelled'

export interface RepositoryReconciliationRequestTable {
  id: string
  sync_run_id: string
  project_id: string
  repository_id: string
  configuration_version: number
  reason: string
  mode: Generated<RepositoryReconciliationMode>
  status: Generated<RepositoryReconciliationRequestStatus>
  requested_by_github_user_id: string | null
  source_sha: string
  production_sha: string
  idempotency_key: string
  superseded_by_request_id: string | null
  attempt_count: Generated<number>
  last_error_code: string | null
  last_error_message: string | null
  requested_at: Date
  claimed_at: Date | null
  completed_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
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
