import { randomUUID } from 'node:crypto'

import type {
  DatabaseClient,
  DatabaseSchema,
  JsonValue,
  ProjectAuditEventType,
  ProjectTable,
} from '@shipgate/database'
import type { Selectable, Transaction } from 'kysely'

import {
  ProjectConfigurationValidationError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
  RepositoryAlreadyConnectedError,
} from './errors.js'
import type { ProjectRecord, ReconciliationRequestRecord, RequiredCheckOverride } from './model.js'
import {
  assertRepositoryTransaction,
  type RepositoryTransaction,
  serializeGitHubNumericId,
} from './repository-transaction.js'
import { normalizeRequiredCheckOverrides, parseRequiredCheckOverrides } from './required-checks.js'
import { queueRequiredChecksSync } from './required-checks-queue.js'
import { queueRepositoryInitialSync } from './sync-queue.js'
import type { ValidatedProjectTopology } from './topology.js'

export type ConfigureProjectResult =
  | {
      readonly status: 'created' | 'updated'
      readonly project: ProjectRecord
      readonly reconciliation: ReconciliationRequestRecord | null
    }
  | {
      readonly status: 'already_applied'
      readonly project: ProjectRecord
      readonly reconciliation: null
    }

export async function listStoredProjects(
  database: DatabaseClient,
): Promise<readonly ProjectRecord[]> {
  const rows = await database.kysely
    .selectFrom('projects')
    .selectAll()
    .where('status', '<>', 'deleted')
    .orderBy('created_at', 'desc')
    .execute()

  return rows.map(mapProject)
}

export async function createConfiguredProject(input: {
  readonly scope: RepositoryTransaction
  readonly topology: ValidatedProjectTopology
  readonly actorGitHubUserId: number
  readonly now?: Date
  readonly projectId?: string
  readonly correlationId: string
  readonly requiredCheckOverrides?: readonly RequiredCheckOverride[]
}): Promise<ConfigureProjectResult> {
  const repositoryId = assertRepositoryTransaction(input.scope, input.topology.repositoryId)
  const installationId = serializeGitHubNumericId(input.topology.installationId, 'installation ID')
  const actorId = serializeGitHubNumericId(input.actorGitHubUserId, 'actor GitHub user ID')
  const now = input.now ?? new Date()
  const projectId = input.projectId ?? randomUUID()
  const transaction = input.scope.transaction

  const existing = await transaction
    .selectFrom('projects')
    .select(['id'])
    .where('repository_id', '=', repositoryId)
    .where('status', '<>', 'deleted')
    .executeTakeFirst()

  if (existing) {
    throw new RepositoryAlreadyConnectedError(repositoryId, existing.id)
  }

  await assertLocalRepositoryState(transaction, installationId, repositoryId)

  const row = await transaction
    .insertInto('projects')
    .values({
      id: projectId,
      installation_id: installationId,
      repository_id: repositoryId,
      owner_id: String(input.topology.ownerId),
      owner_login: input.topology.ownerLogin,
      repository_name: input.topology.repositoryName,
      repository_full_name: input.topology.repositoryFullName,
      default_branch: input.topology.defaultBranch,
      source_branch: input.topology.sourceBranch,
      production_branch: input.topology.productionBranch,
      status: 'initializing',
      source_sha: input.topology.sourceSha,
      production_sha: input.topology.productionSha,
      merge_base_sha: null,
      last_successful_sync_at: null,
      configuration_version: 1,
      required_check_policy_version: 0,
      required_check_overrides: JSON.stringify(
        normalizeRequiredCheckOverrides(input.requiredCheckOverrides ?? []),
      ),
      deletion_requested_at: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  await insertAuditEvent(transaction, {
    projectId,
    repositoryId,
    actorId,
    eventType: 'project_created',
    configurationVersion: 1,
    payload: {
      installationId,
      repositoryId,
      sourceBranch: input.topology.sourceBranch,
      productionBranch: input.topology.productionBranch,
      sourceSha: input.topology.sourceSha,
      productionSha: input.topology.productionSha,
      compareStatus: input.topology.compareStatus,
      requiredCheckOverrides: normalizeRequiredCheckOverrides(input.requiredCheckOverrides ?? []),
    },
    now,
  })
  const reconciliation = await queueRepositoryInitialSync({
    transaction,
    projectId,
    repositoryId,
    configurationVersion: 1,
    reason: 'project_created',
    requestedByGitHubUserId: actorId,
    sourceSha: input.topology.sourceSha,
    productionSha: input.topology.productionSha,
    idempotencyKey: `project-configuration:${projectId}:1`,
    correlationId: input.correlationId,
    causationId: `project:${projectId}:created`,
    triggerScope: {
      reasons: ['project_created'],
      branchNames: [input.topology.sourceBranch, input.topology.productionBranch],
    },
    now,
  })

  return { status: 'created', project: mapProject(row), reconciliation }
}

export async function updateConfiguredProject(input: {
  readonly scope: RepositoryTransaction
  readonly projectId: string
  readonly expectedConfigurationVersion: number
  readonly topology: ValidatedProjectTopology
  readonly actorGitHubUserId: number
  readonly correlationId: string
  readonly requiredCheckOverrides: readonly RequiredCheckOverride[]
  readonly now?: Date
}): Promise<ConfigureProjectResult> {
  const repositoryId = assertRepositoryTransaction(input.scope, input.topology.repositoryId)
  const actorId = serializeGitHubNumericId(input.actorGitHubUserId, 'actor GitHub user ID')
  const now = input.now ?? new Date()
  const transaction = input.scope.transaction
  const project = await requireProject(transaction, input.projectId, repositoryId)

  assertExpectedVersion(project, input.expectedConfigurationVersion)

  if (!['initializing', 'active', 'degraded'].includes(project.status)) {
    throw new ProjectConfigurationValidationError(
      'project_not_active',
      `Project ${project.id} is ${project.status} and cannot be reconfigured`,
    )
  }

  const requiredCheckOverrides = normalizeRequiredCheckOverrides(input.requiredCheckOverrides)
  const overridesChanged =
    JSON.stringify(parseRequiredCheckOverrides(project.required_check_overrides)) !==
    JSON.stringify(requiredCheckOverrides)

  if (
    project.source_branch === input.topology.sourceBranch &&
    project.production_branch === input.topology.productionBranch &&
    !overridesChanged
  ) {
    return { status: 'already_applied', project: mapProject(project), reconciliation: null }
  }

  await assertLocalRepositoryState(transaction, project.installation_id, repositoryId)
  await invalidateProjection(transaction, project.id, now)
  const nextVersion = project.configuration_version + 1
  const row = await transaction
    .updateTable('projects')
    .set({
      owner_id: String(input.topology.ownerId),
      owner_login: input.topology.ownerLogin,
      repository_name: input.topology.repositoryName,
      repository_full_name: input.topology.repositoryFullName,
      default_branch: input.topology.defaultBranch,
      source_branch: input.topology.sourceBranch,
      production_branch: input.topology.productionBranch,
      source_sha: input.topology.sourceSha,
      production_sha: input.topology.productionSha,
      status: 'initializing',
      last_successful_sync_at: null,
      configuration_version: nextVersion,
      required_check_overrides: JSON.stringify(requiredCheckOverrides),
      updated_at: now,
    })
    .where('id', '=', project.id)
    .where('configuration_version', '=', input.expectedConfigurationVersion)
    .returningAll()
    .executeTakeFirst()

  if (!row) {
    const actual = await transaction
      .selectFrom('projects')
      .select('configuration_version')
      .where('id', '=', project.id)
      .executeTakeFirstOrThrow()
    throw new ProjectVersionConflictError(
      project.id,
      input.expectedConfigurationVersion,
      actual.configuration_version,
    )
  }

  await insertAuditEvent(transaction, {
    projectId: project.id,
    repositoryId,
    actorId,
    eventType: 'project_configuration_changed',
    configurationVersion: nextVersion,
    payload: {
      previous: {
        sourceBranch: project.source_branch,
        productionBranch: project.production_branch,
        sourceSha: project.source_sha,
        productionSha: project.production_sha,
        requiredCheckOverrides: parseRequiredCheckOverrides(project.required_check_overrides),
      },
      current: {
        sourceBranch: input.topology.sourceBranch,
        productionBranch: input.topology.productionBranch,
        sourceSha: input.topology.sourceSha,
        productionSha: input.topology.productionSha,
        requiredCheckOverrides,
      },
      compareStatus: input.topology.compareStatus,
    },
    now,
  })
  const reconciliation = await queueRepositoryInitialSync({
    transaction,
    projectId: project.id,
    repositoryId,
    configurationVersion: nextVersion,
    reason: 'project_configuration_changed',
    requestedByGitHubUserId: actorId,
    sourceSha: input.topology.sourceSha,
    productionSha: input.topology.productionSha,
    idempotencyKey: `project-configuration:${project.id}:${nextVersion}`,
    correlationId: input.correlationId,
    causationId: `project:${project.id}:configuration:${nextVersion}`,
    triggerScope: {
      reasons: ['branch_configuration_changed'],
      branchNames: [input.topology.sourceBranch, input.topology.productionBranch],
      requireReconciliation: true,
    },
    now,
  })

  return { status: 'updated', project: mapProject(row), reconciliation }
}

export async function updateProjectRequiredCheckOverrides(input: {
  readonly scope: RepositoryTransaction
  readonly projectId: string
  readonly expectedConfigurationVersion: number
  readonly requiredCheckOverrides: readonly RequiredCheckOverride[]
  readonly actorGitHubUserId: number
  readonly correlationId: string
  readonly now?: Date
}): Promise<ConfigureProjectResult> {
  const repositoryId = input.scope.repositoryId
  assertRepositoryTransaction(input.scope, repositoryId)
  const transaction = input.scope.transaction
  const actorId = serializeGitHubNumericId(input.actorGitHubUserId, 'actor GitHub user ID')
  const now = input.now ?? new Date()
  const project = await requireProject(transaction, input.projectId, repositoryId)

  assertExpectedVersion(project, input.expectedConfigurationVersion)

  if (!['initializing', 'active', 'degraded', 'disconnected'].includes(project.status)) {
    throw new ProjectConfigurationValidationError(
      'project_not_active',
      `Project ${project.id} is ${project.status} and cannot be reconfigured`,
    )
  }

  const previous = parseRequiredCheckOverrides(project.required_check_overrides)
  const current = normalizeRequiredCheckOverrides(input.requiredCheckOverrides)
  const activeReconciliations = await transaction
    .selectFrom('repository_reconciliation_requests')
    .select(['id', 'sync_run_id', 'source_sha', 'production_sha', 'requested_at'])
    .where('project_id', '=', project.id)
    .where('status', 'in', ['queued', 'running'])
    .orderBy('requested_at', 'desc')
    .execute()

  if (JSON.stringify(previous) === JSON.stringify(current)) {
    return { status: 'already_applied', project: mapProject(project), reconciliation: null }
  }

  const nextVersion = project.configuration_version + 1
  const row = await transaction
    .updateTable('projects')
    .set({
      required_check_overrides: JSON.stringify(current),
      configuration_version: nextVersion,
      updated_at: now,
    })
    .where('id', '=', project.id)
    .where('configuration_version', '=', input.expectedConfigurationVersion)
    .returningAll()
    .executeTakeFirst()

  if (!row) {
    const actual = await transaction
      .selectFrom('projects')
      .select('configuration_version')
      .where('id', '=', project.id)
      .executeTakeFirstOrThrow()
    throw new ProjectVersionConflictError(
      project.id,
      input.expectedConfigurationVersion,
      actual.configuration_version,
    )
  }

  await insertAuditEvent(transaction, {
    projectId: project.id,
    repositoryId,
    actorId,
    eventType: 'project_required_check_overrides_changed',
    configurationVersion: nextVersion,
    payload: { previous, current },
    now,
  })
  await queueRequiredChecksSync({
    transaction,
    projectId: project.id,
    repositoryId,
    configurationVersion: nextVersion,
    refreshPolicy: true,
    reason: 'project_required_check_overrides_changed',
    actorGitHubUserId: actorId,
    correlationId: input.correlationId,
    causationId: `project:${project.id}:required-check-overrides:${nextVersion}`,
  })

  const latestActiveReconciliation = activeReconciliations[0]
  const reconciliation = latestActiveReconciliation
    ? await queueRepositoryInitialSync({
        transaction,
        projectId: project.id,
        repositoryId,
        configurationVersion: nextVersion,
        reason: 'project_required_check_overrides_changed_during_reconciliation',
        requestedByGitHubUserId: actorId,
        sourceSha: latestActiveReconciliation.source_sha,
        productionSha: latestActiveReconciliation.production_sha,
        idempotencyKey: `project-required-check-overrides:${project.id}:${nextVersion}:repository-sync`,
        correlationId: input.correlationId,
        causationId: `project:${project.id}:required-check-overrides:${nextVersion}:repository-sync`,
        triggerScope: {
          reasons: ['project_required_check_overrides_changed'],
          requireReconciliation: true,
        },
        now,
      })
    : null

  if (reconciliation) {
    await supersedeReconciliations(transaction, activeReconciliations, reconciliation.id, now)
  }

  return { status: 'updated', project: mapProject(row), reconciliation }
}

export async function requestProjectDeletion(input: {
  readonly scope: RepositoryTransaction
  readonly projectId: string
  readonly expectedConfigurationVersion: number
  readonly actorGitHubUserId: number
  readonly now?: Date
}): Promise<ProjectRecord> {
  const repositoryId = input.scope.repositoryId
  assertRepositoryTransaction(input.scope, repositoryId)
  const actorId = serializeGitHubNumericId(input.actorGitHubUserId, 'actor GitHub user ID')
  const now = input.now ?? new Date()
  const transaction = input.scope.transaction
  const project = await requireProject(transaction, input.projectId, repositoryId)

  assertExpectedVersion(project, input.expectedConfigurationVersion)

  if (project.status === 'pending_deletion') {
    return mapProject(project)
  }

  const nextVersion = project.configuration_version + 1
  const activeRequests = await transaction
    .selectFrom('repository_reconciliation_requests')
    .select(['id', 'sync_run_id'])
    .where('project_id', '=', project.id)
    .where('status', 'in', ['queued', 'running'])
    .execute()

  if (activeRequests.length > 0) {
    await transaction
      .updateTable('repository_sync_runs')
      .set({
        status: 'superseded',
        completed_at: now,
        error_code: 'synchronization_superseded',
        error_message: 'Project deletion was requested',
      })
      .where(
        'id',
        'in',
        activeRequests.map((request) => request.sync_run_id),
      )
      .where('status', 'in', ['queued', 'running'])
      .execute()

    await transaction
      .updateTable('repository_reconciliation_requests')
      .set({
        status: 'cancelled',
        completed_at: now,
        last_error_code: 'synchronization_cancelled',
        last_error_message: 'Project deletion was requested',
        updated_at: now,
      })
      .where(
        'id',
        'in',
        activeRequests.map((request) => request.id),
      )
      .execute()
  }
  const row = await transaction
    .updateTable('projects')
    .set({
      status: 'pending_deletion',
      configuration_version: nextVersion,
      deletion_requested_at: now,
      updated_at: now,
    })
    .where('id', '=', project.id)
    .returningAll()
    .executeTakeFirstOrThrow()

  await insertAuditEvent(transaction, {
    projectId: project.id,
    repositoryId,
    actorId,
    eventType: 'project_deletion_requested',
    configurationVersion: nextVersion,
    payload: {
      previousStatus: project.status,
      status: 'pending_deletion',
    },
    now,
  })

  return mapProject(row)
}

async function supersedeReconciliations(
  transaction: Transaction<DatabaseSchema>,
  reconciliations: readonly {
    readonly id: string
    readonly sync_run_id: string
  }[],
  replacementRequestId: string,
  now: Date,
): Promise<void> {
  if (reconciliations.length === 0) {
    return
  }

  await transaction
    .updateTable('repository_sync_runs')
    .set({
      status: 'superseded',
      completed_at: now,
      error_code: 'synchronization_superseded',
      error_message: 'Required-check overrides changed while reconciliation was pending',
    })
    .where(
      'id',
      'in',
      reconciliations.map((reconciliation) => reconciliation.sync_run_id),
    )
    .where('status', 'in', ['queued', 'running'])
    .execute()

  await transaction
    .updateTable('repository_reconciliation_requests')
    .set({
      status: 'superseded',
      superseded_by_request_id: replacementRequestId,
      completed_at: now,
      last_error_code: 'synchronization_superseded',
      last_error_message: 'Required-check overrides changed while reconciliation was pending',
      updated_at: now,
    })
    .where(
      'id',
      'in',
      reconciliations.map((reconciliation) => reconciliation.id),
    )
    .where('status', 'in', ['queued', 'running'])
    .execute()
}

async function assertLocalRepositoryState(
  transaction: Transaction<DatabaseSchema>,
  installationId: string,
  repositoryId: string,
): Promise<void> {
  const row = await transaction
    .selectFrom('github_installation_repositories as repository')
    .innerJoin(
      'github_installations as installation',
      'installation.installation_id',
      'repository.installation_id',
    )
    .select([
      'repository.archived',
      'repository.disabled',
      'installation.lifecycle_state',
      'installation.permission_state',
    ])
    .where('repository.installation_id', '=', installationId)
    .where('repository.repository_id', '=', repositoryId)
    .executeTakeFirst()

  if (!row) {
    throw new ProjectConfigurationValidationError(
      'repository_unavailable',
      'Repository is not selected by the GitHub App installation',
    )
  }

  if (row.lifecycle_state !== 'active' || row.permission_state !== 'current') {
    throw new ProjectConfigurationValidationError(
      'installation_unavailable',
      'GitHub App installation is not active with current permissions',
      { details: { lifecycleState: row.lifecycle_state, permissionState: row.permission_state } },
    )
  }

  if (row.archived || row.disabled) {
    throw new ProjectConfigurationValidationError(
      'repository_unavailable',
      row.archived ? 'Repository is archived' : 'Repository is disabled',
    )
  }
}

async function requireProject(
  transaction: Transaction<DatabaseSchema>,
  projectId: string,
  repositoryId: string,
): Promise<Selectable<ProjectTable>> {
  const project = await transaction
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', projectId)
    .forUpdate()
    .executeTakeFirst()

  if (!project || project.status === 'deleted' || project.repository_id !== repositoryId) {
    throw new ProjectNotFoundError(projectId)
  }

  return project
}

function assertExpectedVersion(project: Selectable<ProjectTable>, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected <= 0) {
    throw new TypeError('expectedConfigurationVersion must be a positive safe integer')
  }

  if (project.configuration_version !== expected) {
    throw new ProjectVersionConflictError(project.id, expected, project.configuration_version)
  }
}

async function invalidateProjection(
  transaction: Transaction<DatabaseSchema>,
  projectId: string,
  now: Date,
): Promise<void> {
  await transaction.deleteFrom('change_commits').where('project_id', '=', projectId).execute()
  await transaction.deleteFrom('repository_commits').where('project_id', '=', projectId).execute()
  await transaction.deleteFrom('repository_branches').where('project_id', '=', projectId).execute()
  await transaction
    .updateTable('changes')
    .set({
      source_integration_sha: null,
      commit_set_fingerprint: null,
      synchronization_state: 'unknown',
      production_presence: 'unknown',
      observed_at: now,
      updated_at: now,
    })
    .where('project_id', '=', projectId)
    .execute()
}

async function insertAuditEvent(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly projectId: string
    readonly repositoryId: string
    readonly actorId: string
    readonly eventType: ProjectAuditEventType
    readonly configurationVersion: number
    readonly payload: JsonValue
    readonly now: Date
  },
): Promise<void> {
  await transaction
    .insertInto('project_audit_events')
    .values({
      id: randomUUID(),
      project_id: input.projectId,
      repository_id: input.repositoryId,
      actor_github_user_id: input.actorId,
      event_type: input.eventType,
      source: 'user',
      configuration_version: input.configurationVersion,
      payload: JSON.stringify(input.payload),
      occurred_at: input.now,
    })
    .execute()
}

function mapProject(row: Selectable<ProjectTable>): ProjectRecord {
  return {
    id: row.id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    ownerId: row.owner_id,
    ownerLogin: row.owner_login,
    repositoryName: row.repository_name,
    repositoryFullName: row.repository_full_name,
    defaultBranch: row.default_branch,
    sourceBranch: row.source_branch,
    productionBranch: row.production_branch,
    status: row.status,
    sourceSha: row.source_sha,
    productionSha: row.production_sha,
    mergeBaseSha: row.merge_base_sha,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    configurationVersion: row.configuration_version,
    requiredCheckPolicyVersion: row.required_check_policy_version,
    requiredCheckOverrides: parseRequiredCheckOverrides(row.required_check_overrides),
    deletionRequestedAt: row.deletion_requested_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
