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

  change_qa_assessments: ChangeQaAssessmentTable

  effective_change_qa_assessments: EffectiveChangeQaAssessmentView

  change_dependencies: ChangeDependencyTable

  release_candidates: ReleaseCandidateTable

  candidate_exclusions: CandidateExclusionTable

  release_candidate_evaluations: ReleaseCandidateEvaluationTable

  required_checks: RequiredCheckTable

  commit_check_results: CommitCheckResultTable

  change_required_check_states: ChangeRequiredCheckStateTable

  repository_sync_runs: RepositorySyncRunTable

  repository_sync_issues: RepositorySyncIssueTable

  audit_events: AuditEventTable

  repository_reconciliation_requests: RepositoryReconciliationRequestTable

  repository_incremental_sync_requests: RepositoryIncrementalSyncRequestTable

  repository_projection_archives: RepositoryProjectionArchiveTable

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

export type GitHubWebhookProcessingState =
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'ignored'
  | 'failed'

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
  ignored_reason: Generated<string | null>
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
  required_check_policy_version: Generated<number>
  required_check_overrides: ColumnType<JsonValue, string, string>
  qa_reset_epoch: Generated<number>
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

export type RequiredCheckSource = 'branch_protection' | 'repository_ruleset' | 'project_override'

export interface RequiredCheckTable {
  id: string
  project_id: string
  repository_id: string
  policy_version: number
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
  updated_at: Generated<Date>
}

export type RequiredCheckState = 'pending' | 'successful' | 'failed' | 'missing' | 'stale'

export interface ChangeRequiredCheckStateTable {
  project_id: string
  repository_id: string
  change_id: string
  required_check_id: string
  policy_version: number
  commit_sha: string
  state: RequiredCheckState
  evidence_ids: ColumnType<JsonValue, string, string>
  observed_at: Date
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type RepositorySyncRunStatus = 'queued' | 'running' | 'succeeded' | 'superseded' | 'failed'

export type RepositoryReconciliationClassification =
  | 'expected_change'
  | 'recoverable_drift'
  | 'destructive_history_change'
  | 'permission_problem'
  | 'unknown_inconsistency'

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
  reconciliation_classification: Generated<RepositoryReconciliationClassification | null>
  difference_summary: ColumnType<JsonValue | null, string | null | undefined, string | null>
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

export type QaAssessmentStatus = 'pending' | 'passed' | 'failed'

export interface ChangeQaAssessmentTable {
  id: string
  project_id: string
  repository_id: string
  change_id: string
  final_head_sha: string
  commit_set_fingerprint: string
  sequence: number
  status: QaAssessmentStatus
  actor_github_user_id: string | null
  comment: string | null
  previous_status: QaAssessmentStatus | null
  correlation_id: string
  reason_code: string
  qa_reset_epoch: Generated<number>
  created_at: Generated<Date>
}

export interface EffectiveChangeQaAssessmentView {
  id: ColumnType<string, never, never>
  project_id: ColumnType<string, never, never>
  repository_id: ColumnType<string, never, never>
  change_id: ColumnType<string, never, never>
  final_head_sha: ColumnType<string, never, never>
  commit_set_fingerprint: ColumnType<string, never, never>
  sequence: ColumnType<number, never, never>
  status: ColumnType<QaAssessmentStatus, never, never>
  actor_github_user_id: ColumnType<string | null, never, never>
  comment: ColumnType<string | null, never, never>
  previous_status: ColumnType<QaAssessmentStatus | null, never, never>
  correlation_id: ColumnType<string, never, never>
  reason_code: ColumnType<string, never, never>
  qa_reset_epoch: ColumnType<number, never, never>
  created_at: ColumnType<Date, never, never>
}

export type ChangeDependencySource = 'user' | 'managed_pr_body' | 'system'

export interface ChangeDependencyTable {
  project_id: string
  repository_id: string
  dependent_change_id: string
  prerequisite_change_id: string
  source: ChangeDependencySource
  actor_github_user_id: string | null
  comment: string | null
  version: number
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type ReleaseCandidateState = 'open' | 'revision_active' | 'completed' | 'cancelled'

export interface ReleaseCandidateTable {
  id: string
  project_id: string
  repository_id: string
  sequence: number
  state: Generated<ReleaseCandidateState>
  version: Generated<number>
  created_by_github_user_id: string
  note: string | null
  latest_evaluation_version: number | null
  closed_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface CandidateExclusionTable {
  candidate_id: string
  project_id: string
  repository_id: string
  change_id: string
  actor_github_user_id: string
  reason: string | null
  candidate_version: number
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type ReleaseCandidateEvaluationResult = 'ready' | 'blocked'

export interface ReleaseCandidateEvaluationTable {
  id: string
  candidate_id: string
  project_id: string
  repository_id: string
  evaluation_version: number
  candidate_version: number
  configuration_version: number
  source_sha: string
  production_sha: string
  projection_fingerprint: string
  required_check_policy_version: number
  result: ReleaseCandidateEvaluationResult
  evaluation_fingerprint: string
  summary: ColumnType<JsonValue, string, string>
  blockers: ColumnType<JsonValue, string, string>
  evaluated_at: Date
  created_at: Generated<Date>
}

export type ProjectAuditEventType =
  | 'project_created'
  | 'project_configuration_changed'
  | 'project_required_check_overrides_changed'
  | 'required_check_policy_changed'
  | 'required_check_policy_refreshed'
  | 'project_deletion_requested'

export type ReleasePlanningAuditEventType =
  | 'qa_assessment_recorded'
  | 'qa_assessment_reset'
  | 'dependencies_replaced'
  | 'release_candidate_created'
  | 'change_excluded_from_candidate'
  | 'change_restored_to_candidate'
  | 'release_candidate_evaluated'

export type AuditEventType = ProjectAuditEventType | ReleasePlanningAuditEventType

export type AuditEventSource = 'user' | 'webhook' | 'reconciliation' | 'system'

export type ProjectAuditSource = Exclude<AuditEventSource, 'webhook'>

export type AuditEntityType =
  | 'project'
  | 'change'
  | 'qa_assessment'
  | 'dependency'
  | 'release_candidate'
  | 'candidate_exclusion'
  | 'release_candidate_evaluation'

export interface AuditEventTable {
  id: string
  project_id: string
  repository_id: string
  actor_github_user_id: string | null
  event_type: AuditEventType
  source: AuditEventSource
  configuration_version: number | null
  entity_type: AuditEntityType
  entity_id: string
  correlation_id: string | null
  reason_code: string | null
  before_state: ColumnType<JsonValue | null, string | null | undefined, string | null>
  after_state: ColumnType<JsonValue | null, string | null | undefined, string | null>
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
  trigger_scope: ColumnType<JsonValue, string, string>
  force_push: Generated<boolean>
  coalesced_count: Generated<number>
  updated_at: Generated<Date>
}

export type RepositoryIncrementalSyncType =
  | 'refresh_branches'
  | 'refresh_change'
  | 'refresh_checks'
  | 'refresh_rules'

export type RepositoryIncrementalSyncRequestStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'superseded'
  | 'failed'

export interface RepositoryIncrementalSyncRequestTable {
  id: string
  project_id: string
  repository_id: string
  configuration_version: number
  sync_type: RepositoryIncrementalSyncType
  status: Generated<RepositoryIncrementalSyncRequestStatus>
  scope: ColumnType<JsonValue, string, string>
  attempt_count: Generated<number>
  last_error_code: string | null
  last_error_message: string | null
  requested_at: Date
  claimed_at: Date | null
  completed_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface RepositoryProjectionArchiveTable {
  id: string
  reconciliation_request_id: string
  sync_run_id: string
  project_id: string
  repository_id: string
  source_sha: string | null
  production_sha: string | null
  classification: Extract<RepositoryReconciliationClassification, 'destructive_history_change'>
  snapshot: ColumnType<JsonValue, string, string>
  archived_at: Date
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
