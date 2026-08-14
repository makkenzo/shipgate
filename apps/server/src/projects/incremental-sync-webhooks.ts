import type { DatabaseClient, DatabaseSchema, JsonValue } from '@shipgate/database'
import type { GitHubWebhookProjectionHandler } from '@shipgate/jobs'
import type { Transaction } from 'kysely'

import { importDependenciesFromPullRequestWebhook } from './dependency-workflow.js'
import { queueRepositoryIncrementalSync } from './incremental-sync-queue.js'

export function createRepositoryWebhookProjectionHandler(
  options: { readonly database?: DatabaseClient } = {},
): GitHubWebhookProjectionHandler {
  return async (execution) => {
    if (options.database) {
      await importDependenciesFromPullRequestWebhook(options.database, execution)
    }
    if (
      execution.event === 'installation' &&
      (execution.action === 'unsuspend' || execution.action === 'new_permissions_accepted')
    ) {
      if (execution.installationId) {
        await queueInstallationReconciliations({
          transaction: execution.transaction,
          installationId: execution.installationId,
          deliveryId: execution.deliveryId,
          reason:
            execution.action === 'unsuspend'
              ? 'installation_unsuspended'
              : 'installation_permissions_changed',
          correlationId: execution.correlationId,
          causationId: execution.causationId ?? `github-webhook:${execution.deliveryId}`,
        })
      }
      return
    }

    if (!execution.repositoryId) {
      return
    }

    const projects = await loadProjects(execution.transaction, execution.repositoryId)

    for (const project of projects) {
      const common = {
        transaction: execution.transaction,
        projectId: project.id,
        repositoryId: project.repository_id,
        configurationVersion: project.configuration_version,
        correlationId: execution.correlationId,
        causationId: execution.causationId ?? `github-webhook:${execution.deliveryId}`,
      } as const

      switch (execution.event) {
        case 'push': {
          const trigger = parsePushTrigger(
            execution.payload,
            project.source_branch,
            project.production_branch,
          )

          if (!trigger) break

          await queueRepositoryIncrementalSync({
            ...common,
            syncType: 'refresh_branches',
            scope: {
              ...installationScope(execution.installationId),
              reasons: [trigger.reason],
              deliveryIds: [execution.deliveryId],
              branchNames: [trigger.branchName],
              ...(trigger.beforeSha ? { beforeShas: [trigger.beforeSha] } : {}),
              ...(trigger.afterSha ? { afterShas: [trigger.afterSha] } : {}),
              forced: trigger.forced,
            },
          })
          break
        }

        case 'pull_request': {
          const trigger = parsePullRequestTrigger(execution.action, execution.payload)

          if (!trigger) break

          await queueRepositoryIncrementalSync({
            ...common,
            syncType: 'refresh_change',
            scope: {
              ...installationScope(execution.installationId),
              reasons: ['github_pull_request_merged'],
              deliveryIds: [execution.deliveryId],
              pullRequestNumbers: [trigger.pullRequestNumber],
              commitShas: trigger.commitShas,
            },
          })
          break
        }

        case 'check_run':
        case 'status': {
          const commitSha =
            execution.event === 'check_run'
              ? readSha(execution.payload, ['check_run', 'head_sha'])
              : readSha(execution.payload, ['sha'])

          if (!commitSha) break

          await queueRepositoryIncrementalSync({
            ...common,
            syncType: 'refresh_checks',
            scope: {
              ...installationScope(execution.installationId),
              reasons: [
                execution.event === 'check_run'
                  ? 'github_check_run_changed'
                  : 'github_commit_status_changed',
              ],
              deliveryIds: [execution.deliveryId],
              commitShas: [commitSha],
            },
          })
          break
        }

        case 'branch_protection_rule':
        case 'repository_ruleset':
          await queueRepositoryIncrementalSync({
            ...common,
            syncType: 'refresh_rules',
            scope: {
              ...installationScope(execution.installationId),
              reasons: [
                execution.event === 'branch_protection_rule'
                  ? 'github_branch_protection_changed'
                  : 'github_repository_ruleset_changed',
              ],
              deliveryIds: [execution.deliveryId],
            },
          })
          break

        case 'repository':
          if (
            [
              'renamed',
              'transferred',
              'edited',
              'archived',
              'unarchived',
              'privatized',
              'publicized',
              'deleted',
            ].includes(execution.action ?? '')
          ) {
            await queueRepositoryIncrementalSync({
              ...common,
              syncType: 'refresh_branches',
              scope: {
                ...installationScope(execution.installationId),
                reasons: [`github_repository_${execution.action}`],
                deliveryIds: [execution.deliveryId],
                refreshMetadata: true,
                requireReconciliation:
                  execution.action === 'renamed' || execution.action === 'transferred',
              },
            })
          }
          break
      }
    }
  }
}

async function queueInstallationReconciliations(input: {
  readonly transaction: Transaction<DatabaseSchema>
  readonly installationId: string
  readonly deliveryId: string
  readonly reason: 'installation_unsuspended' | 'installation_permissions_changed'
  readonly correlationId: string
  readonly causationId: string
}): Promise<void> {
  const projects = await input.transaction
    .selectFrom('projects')
    .select(['id', 'repository_id', 'configuration_version'])
    .where('installation_id', '=', input.installationId)
    .where('status', 'in', ['initializing', 'active', 'degraded', 'disconnected'])
    .orderBy('repository_id')
    .execute()

  for (const project of projects) {
    await queueRepositoryIncrementalSync({
      transaction: input.transaction,
      projectId: project.id,
      repositoryId: project.repository_id,
      configurationVersion: project.configuration_version,
      syncType: 'refresh_branches',
      scope: {
        installationId: input.installationId,
        reasons: [input.reason],
        deliveryIds: [input.deliveryId],
        refreshMetadata: true,
        requireReconciliation: true,
      },
      correlationId: input.correlationId,
      causationId: input.causationId,
    })
  }
}

async function loadProjects(
  transaction: Transaction<DatabaseSchema>,
  repositoryId: string,
): Promise<
  readonly {
    readonly id: string
    readonly repository_id: string
    readonly configuration_version: number
    readonly source_branch: string
    readonly production_branch: string
  }[]
> {
  return transaction
    .selectFrom('projects')
    .select(['id', 'repository_id', 'configuration_version', 'source_branch', 'production_branch'])
    .where('repository_id', '=', repositoryId)
    .where('status', 'in', ['initializing', 'active', 'degraded', 'disconnected'])
    .execute()
}

function installationScope(installationId: string | null): { readonly installationId?: string } {
  return installationId === null ? {} : { installationId }
}

function parsePushTrigger(
  payload: JsonValue,
  sourceBranch: string,
  productionBranch: string,
): {
  readonly branchName: string
  readonly beforeSha: string | undefined
  readonly afterSha: string | undefined
  readonly forced: boolean
  readonly reason: string
} | null {
  if (!isRecord(payload) || typeof payload.ref !== 'string') return null

  const sourceRef = `refs/heads/${sourceBranch}`
  const productionRef = `refs/heads/${productionBranch}`

  if (payload.ref !== sourceRef && payload.ref !== productionRef) return null

  const branchName = payload.ref === sourceRef ? sourceBranch : productionBranch
  return {
    branchName,
    beforeSha: normalizeOptionalPushSha(payload.before),
    afterSha: normalizeOptionalPushSha(payload.after),
    forced: payload.forced === true,
    reason:
      payload.ref === sourceRef ? 'github_source_branch_pushed' : 'github_production_branch_pushed',
  }
}

function parsePullRequestTrigger(
  action: string | null,
  payload: JsonValue,
): { readonly pullRequestNumber: number; readonly commitShas: readonly string[] } | null {
  if (action !== 'closed' || !isRecord(payload) || !isRecord(payload.pull_request)) return null

  const pullRequest = payload.pull_request
  if (pullRequest.merged !== true) return null

  const pullRequestNumber = readPositiveInteger(pullRequest.number)
  if (!pullRequestNumber) return null

  const commitShas = [
    readSha(pullRequest, ['head', 'sha']),
    normalizeOptionalPushSha(pullRequest.merge_commit_sha),
  ].filter((value): value is string => value !== undefined)

  return { pullRequestNumber, commitShas }
}

function readSha(value: JsonValue, path: readonly string[]): string | undefined {
  let current: JsonValue | undefined = value

  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }

  return normalizeOptionalPushSha(current)
}

function normalizeOptionalPushSha(value: JsonValue | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const sha = value.toLowerCase()
  if (!/^[0-9a-f]{40,64}$/.test(sha) || /^0+$/.test(sha)) return undefined
  return sha
}

function readPositiveInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
