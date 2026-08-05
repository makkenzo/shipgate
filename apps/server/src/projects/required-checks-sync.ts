import type { DatabaseClient, DatabaseSchema, JsonValue } from '@shipgate/database'
import type { GitHubAuthenticationService } from '@shipgate/github'
import {
  PermanentJobError,
  type RepositoryRequiredChecksSyncExecution,
  type RepositoryRequiredChecksSyncHandler,
  RetryableJobError,
} from '@shipgate/jobs'
import type { Kysely } from 'kysely'

import { ProjectConfigurationValidationError } from './errors.js'
import type { CommitCheckResultProjection, RequiredCheckProjection } from './model.js'
import {
  type RepositoryLock,
  withRepositoryLock,
  withRepositoryTransactionInLock,
} from './repository-transaction.js'
import {
  loadCheckResultsForCommit,
  loadEffectiveRequiredChecks,
  parseRequiredCheckOverrides,
  requiredChecksPermissions,
} from './required-checks.js'
import {
  applyRequiredCheckProjectionInTransaction,
  type RequiredCheckProjectionTrigger,
} from './required-checks-store.js'

export function createRepositoryRequiredChecksSyncHandler(options: {
  readonly database: DatabaseClient
  readonly githubAuth: GitHubAuthenticationService
}): RepositoryRequiredChecksSyncHandler {
  return async (execution) => {
    try {
      return await executeSync(options, execution)
    } catch (error) {
      const retryable = isRetryable(error)

      execution.logger[retryable ? 'warn' : 'error'](
        {
          event: retryable
            ? 'repository.required_checks_sync.retrying'
            : 'repository.required_checks_sync.failed',
          projectId: execution.projectId,
          repositoryId: execution.repositoryId,
          attempt: execution.attempt,
          err: toError(error),
        },
        retryable
          ? 'Required-check synchronization will be retried'
          : 'Required-check synchronization failed permanently',
      )

      if (retryable && execution.attempt < execution.maxAttempts) {
        throw new RetryableJobError('Required-check synchronization failed temporarily', {
          code: errorCode(error),
          cause: error,
        })
      }

      throw new PermanentJobError('Required-check synchronization failed permanently', {
        code: errorCode(error),
        cause: error,
      })
    }
  }
}

async function executeSync(
  options: {
    readonly database: DatabaseClient
    readonly githubAuth: GitHubAuthenticationService
  },
  execution: RepositoryRequiredChecksSyncExecution,
): Promise<JsonValue> {
  const project = await options.database.kysely
    .selectFrom('projects')
    .select([
      'id',
      'repository_id',
      'installation_id',
      'owner_login',
      'repository_name',
      'source_branch',
      'configuration_version',
      'required_check_policy_version',
      'required_check_overrides',
      'status',
    ])
    .where('id', '=', execution.projectId)
    .executeTakeFirst()

  if (
    !project ||
    project.repository_id !== execution.repositoryId ||
    project.status === 'pending_deletion' ||
    project.status === 'deleted'
  ) {
    return { status: 'ignored', reason: 'project_not_runnable' }
  }

  if (project.configuration_version !== execution.configurationVersion) {
    return { status: 'ignored', reason: 'configuration_superseded' }
  }

  const installationId = parseGitHubId(project.installation_id, 'installation ID')
  const repositoryId = parseGitHubId(project.repository_id, 'repository ID')
  const client = await options.githubAuth.getInstallationClient({
    installationId,
    repositoryIds: [repositoryId],
    permissions: requiredChecksPermissions,
  })
  const refreshPolicy = execution.refreshPolicy || project.required_check_policy_version === 0
  const requiredChecks = refreshPolicy
    ? await loadEffectiveRequiredChecks({
        client,
        repository: { ownerLogin: project.owner_login, name: project.repository_name },
        sourceBranch: project.source_branch,
        overrides: parseRequiredCheckOverrides(project.required_check_overrides),
      })
    : await loadStoredPolicy(
        options.database.kysely,
        project.id,
        project.required_check_policy_version,
      )
  const changes = await loadTargetChanges(options.database.kysely, {
    projectId: project.id,
    commitSha: refreshPolicy ? undefined : execution.commitSha,
  })

  if (!refreshPolicy && changes.length === 0) {
    return { status: 'ignored', reason: 'change_not_projected' }
  }

  const observedAt = new Date()
  const targetCommitShas = [...new Set(changes.map((change) => change.final_head_sha))]
  const checkResults = (
    await Promise.all(
      targetCommitShas.map((commitSha) =>
        loadCheckResultsForCommit({
          client,
          repository: { ownerLogin: project.owner_login, name: project.repository_name },
          commitSha,
          observedAt,
        }),
      ),
    )
  ).flat()

  return withRepositoryLock(options.database, project.repository_id, async (lock) =>
    commitProjection(lock, {
      project,
      execution,
      requiredChecks,
      checkResults,
      targetCommitShas,
      refreshPolicy,
      observedAt,
    }),
  )
}

async function commitProjection(
  lock: RepositoryLock,
  input: {
    readonly project: {
      readonly id: string
      readonly repository_id: string
      readonly source_branch: string
      readonly configuration_version: number
    }
    readonly execution: RepositoryRequiredChecksSyncExecution
    readonly requiredChecks: readonly RequiredCheckProjection[]
    readonly checkResults: readonly CommitCheckResultProjection[]
    readonly targetCommitShas: readonly string[]
    readonly refreshPolicy: boolean
    readonly observedAt: Date
  },
): Promise<JsonValue> {
  return withRepositoryTransactionInLock(lock, async (scope) => {
    const current = await scope.transaction
      .selectFrom('projects')
      .select(['configuration_version', 'source_branch', 'status'])
      .where('id', '=', input.project.id)
      .forUpdate()
      .executeTakeFirst()

    if (
      !current ||
      current.configuration_version !== input.project.configuration_version ||
      current.source_branch !== input.project.source_branch ||
      current.status === 'pending_deletion' ||
      current.status === 'deleted'
    ) {
      return { status: 'ignored', reason: 'project_changed_during_load' }
    }

    const currentTargetCommitShas = await loadCurrentTargetCommitShas(
      scope.transaction,
      input.project.id,
      input.refreshPolicy ? undefined : input.execution.commitSha,
    )

    if (!sameStringSet(currentTargetCommitShas, input.targetCommitShas)) {
      if (!input.refreshPolicy) {
        return { status: 'ignored', reason: 'change_changed_during_load' }
      }

      throw new ProjectConfigurationValidationError(
        'repository_state_changed',
        'Unreleased change heads changed while required checks were being loaded',
      )
    }

    const trigger: RequiredCheckProjectionTrigger = {
      reason: input.execution.reason,
      auditSource: input.execution.actorGitHubUserId
        ? 'user'
        : input.execution.deliveryId
          ? 'system'
          : 'reconciliation',
      actorGitHubUserId: input.execution.actorGitHubUserId ?? null,
      ...(input.execution.deliveryId ? { deliveryId: input.execution.deliveryId } : {}),
      auditWhenUnchanged: input.refreshPolicy && input.execution.deliveryId !== undefined,
    }
    const applied = await applyRequiredCheckProjectionInTransaction(scope, {
      projectId: input.project.id,
      repositoryId: input.project.repository_id,
      expectedConfigurationVersion: input.project.configuration_version,
      requiredChecks: input.requiredChecks,
      checkResults: input.checkResults,
      targetCommitShas: input.targetCommitShas,
      recomputeAllChanges: input.refreshPolicy,
      observedAt: input.observedAt,
      trigger,
    })

    return {
      status: 'applied',
      policyVersion: applied.policyVersion,
      policyChanged: applied.policyChanged,
      changeCount: applied.changeCount,
      stateCount: applied.stateCount,
    }
  })
}

async function loadStoredPolicy(
  transaction: Kysely<DatabaseSchema>,
  projectId: string,
  policyVersion: number,
): Promise<readonly RequiredCheckProjection[]> {
  const rows = await transaction
    .selectFrom('required_checks')
    .select(['id', 'context', 'integration_id', 'source', 'source_reference'])
    .where('project_id', '=', projectId)
    .where('policy_version', '=', policyVersion)
    .execute()

  return rows.map((row) => ({
    id: row.id,
    context: row.context,
    integrationId:
      row.integration_id === null ? null : parseGitHubId(row.integration_id, 'integration ID'),
    source: row.source,
    sourceReference: row.source_reference,
  }))
}

async function loadTargetChanges(
  transaction: Kysely<DatabaseSchema>,
  input: { readonly projectId: string; readonly commitSha: string | undefined },
): Promise<readonly { readonly id: string; readonly final_head_sha: string }[]> {
  let query = transaction
    .selectFrom('changes')
    .select(['id', 'final_head_sha'])
    .where('project_id', '=', input.projectId)
    .where('synchronization_state', '=', 'known')
    .where('production_presence', 'in', ['unreleased', 'partially_present'])

  if (input.commitSha !== undefined) {
    query = query.where('final_head_sha', '=', input.commitSha)
  }

  return query.orderBy('merged_at').orderBy('pull_request_number').execute()
}

async function loadCurrentTargetCommitShas(
  transaction: Kysely<DatabaseSchema>,
  projectId: string,
  commitSha: string | undefined,
): Promise<readonly string[]> {
  let query = transaction
    .selectFrom('changes')
    .select('final_head_sha')
    .where('project_id', '=', projectId)
    .where('synchronization_state', '=', 'known')
    .where('production_presence', 'in', ['unreleased', 'partially_present'])

  if (commitSha !== undefined) {
    query = query.where('final_head_sha', '=', commitSha)
  }

  const rows = await query.execute()
  return [...new Set(rows.map((row) => row.final_head_sha))].toSorted()
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].toSorted()
  const normalizedRight = [...new Set(right)].toSorted()

  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  )
}

function parseGitHubId(value: string, name: string): number {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Stored ${name} is invalid: ${value}`)
  }

  return parsed
}

function isRetryable(value: unknown): boolean {
  if (value instanceof ProjectConfigurationValidationError) {
    return value.code === 'external_state_unknown' || value.code === 'repository_state_changed'
  }

  const status = getHttpStatus(value)
  return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500
}

function errorCode(value: unknown): string {
  if (value instanceof ProjectConfigurationValidationError) {
    return value.code.toUpperCase()
  }

  const status = getHttpStatus(value)
  return status === undefined ? 'REQUIRED_CHECKS_SYNC_FAILED' : `GITHUB_HTTP_${status}`
}

function getHttpStatus(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    return undefined
  }

  const status = Reflect.get(value, 'status')
  return typeof status === 'number' ? status : undefined
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
