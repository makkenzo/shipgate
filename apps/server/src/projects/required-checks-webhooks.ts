import type { DatabaseSchema, JsonValue } from '@shipgate/database'
import type { GitHubWebhookProjectionHandler } from '@shipgate/jobs'
import type { Transaction } from 'kysely'

import { queueRequiredChecksSync } from './required-checks-queue.js'

export function createRequiredChecksWebhookProjectionHandler(): GitHubWebhookProjectionHandler {
  return async (execution) => {
    if (!execution.repositoryId) {
      return
    }

    const trigger = parseTrigger(execution.event, execution.payload)

    if (!trigger) {
      return
    }

    const projects = await loadProjects(execution.transaction, execution.repositoryId)

    for (const project of projects) {
      await queueRequiredChecksSync({
        transaction: execution.transaction,
        projectId: project.id,
        repositoryId: project.repository_id,
        configurationVersion: project.configuration_version,
        refreshPolicy: trigger.refreshPolicy,
        ...(trigger.commitSha ? { commitSha: trigger.commitSha } : {}),
        reason: trigger.reason,
        deliveryId: execution.deliveryId,
        correlationId: execution.correlationId,
        causationId: execution.causationId ?? `github-webhook:${execution.deliveryId}`,
      })
    }
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
  }[]
> {
  return transaction
    .selectFrom('projects')
    .select(['id', 'repository_id', 'configuration_version'])
    .where('repository_id', '=', repositoryId)
    .where('status', 'in', ['initializing', 'active', 'degraded', 'disconnected'])
    .execute()
}

function parseTrigger(
  event: string,
  payload: JsonValue,
): {
  readonly refreshPolicy: boolean
  readonly commitSha?: string
  readonly reason: string
} | null {
  switch (event) {
    case 'branch_protection_rule':
      return { refreshPolicy: true, reason: 'github_branch_protection_changed' }
    case 'repository_ruleset':
      return { refreshPolicy: true, reason: 'github_repository_ruleset_changed' }
    case 'check_run': {
      const commitSha = readSha(payload, ['check_run', 'head_sha'])
      return commitSha
        ? { refreshPolicy: false, commitSha, reason: 'github_check_run_changed' }
        : null
    }
    case 'status': {
      const commitSha = readSha(payload, ['sha'])
      return commitSha
        ? { refreshPolicy: false, commitSha, reason: 'github_commit_status_changed' }
        : null
    }
    default:
      return null
  }
}

function readSha(value: JsonValue, path: readonly string[]): string | undefined {
  let current: JsonValue | undefined = value

  for (const key of path) {
    if (!isRecord(current)) {
      return undefined
    }

    current = current[key]
  }

  if (typeof current !== 'string') {
    return undefined
  }

  const sha = current.toLowerCase()
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined
}

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
