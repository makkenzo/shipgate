import {
  createDatabase,
  type DatabaseClient,
  type JsonValue,
  migrateToLatest,
} from '@shipgate/database'
import { migrateJobQueue } from '@shipgate/jobs'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createRepositoryWebhookProjectionHandler,
  withRepositoryTransaction,
} from '../src/projects/index.js'

const sourceSha = 'a'.repeat(40)
const productionSha = 'b'.repeat(40)

const handler = createRepositoryWebhookProjectionHandler()

describe.sequential('Incremental repository webhook projection', () => {
  let postgres: PostgresTestDatabase
  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    database = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: 'shipgate-incremental-webhook-test',
      ssl: { mode: 'disable' },
      pool: {
        min: 0,
        max: 6,
        idleTimeoutMs: 5_000,
        connectionTimeoutMs: 5_000,
        maxLifetimeSeconds: 0,
      },
      allowExitOnIdle: true,
      onPoolError: () => undefined,
    })
    await migrateJobQueue(database)
    await migrateToLatest(database.kysely)
  }, 60_000)

  afterAll(async () => {
    await database.destroy()
    await postgres.stop()
  })

  it('coalesces repeated and out-of-order pushes while preserving the complete reconciliation range', async () => {
    const fixture = await seedProject(database, 1)
    const newestSha = 'c'.repeat(40)
    const intermediateSha = 'd'.repeat(40)

    await projectWebhook(database, fixture, {
      deliveryId: 'push-newest',
      event: 'push',
      action: null,
      payload: {
        ref: 'refs/heads/develop',
        before: intermediateSha,
        after: newestSha,
        forced: false,
      },
    })
    await projectWebhook(database, fixture, {
      deliveryId: 'push-older',
      event: 'push',
      action: null,
      payload: {
        ref: 'refs/heads/develop',
        before: sourceSha,
        after: intermediateSha,
        forced: false,
      },
    })
    await projectWebhook(database, fixture, {
      deliveryId: 'push-newest',
      event: 'push',
      action: null,
      payload: {
        ref: 'refs/heads/develop',
        before: intermediateSha,
        after: newestSha,
        forced: false,
      },
    })

    const requests = await loadRequests(database, fixture.projectId)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ sync_type: 'refresh_branches', status: 'queued' })
    expect(requests[0]?.scope).toMatchObject({
      reasons: ['github_source_branch_pushed'],
      deliveryIds: ['push-newest', 'push-older'],
      branchNames: ['develop'],
      beforeShas: [sourceSha, intermediateSha],
      afterShas: [newestSha, intermediateSha].toSorted(),
      forced: false,
    })
    expect(await countJobs(database, fixture.projectId)).toBe(1)
  })

  it('routes pull requests, checks, statuses and rule changes into targeted coalesced jobs', async () => {
    const fixture = await seedProject(database, 2)
    const pullHead = 'e'.repeat(40)
    const mergeCommit = 'f'.repeat(40)
    const statusSha = '1'.repeat(40)

    await projectWebhook(database, fixture, {
      deliveryId: 'pull-merged',
      event: 'pull_request',
      action: 'closed',
      payload: {
        pull_request: {
          number: 42,
          merged: true,
          merge_commit_sha: mergeCommit,
          head: { sha: pullHead },
        },
      },
    })
    await projectWebhook(database, fixture, {
      deliveryId: 'check-run',
      event: 'check_run',
      action: 'completed',
      payload: { check_run: { head_sha: pullHead } },
    })
    await projectWebhook(database, fixture, {
      deliveryId: 'legacy-status',
      event: 'status',
      action: null,
      payload: { sha: statusSha },
    })
    await projectWebhook(database, fixture, {
      deliveryId: 'branch-protection',
      event: 'branch_protection_rule',
      action: 'edited',
      payload: {},
    })
    await projectWebhook(database, fixture, {
      deliveryId: 'repository-ruleset',
      event: 'repository_ruleset',
      action: 'edited',
      payload: {},
    })

    const requests = await loadRequests(database, fixture.projectId)
    const byType = new Map(requests.map((request) => [request.sync_type, request] as const))

    expect(requests.map((request) => request.sync_type).toSorted()).toEqual([
      'refresh_change',
      'refresh_checks',
      'refresh_rules',
    ])
    expect(byType.get('refresh_change')?.scope).toMatchObject({
      deliveryIds: ['pull-merged'],
      pullRequestNumbers: [42],
      commitShas: [mergeCommit, pullHead].toSorted(),
    })
    expect(byType.get('refresh_checks')?.scope).toMatchObject({
      deliveryIds: ['check-run', 'legacy-status'],
      commitShas: [pullHead, statusSha].toSorted(),
      reasons: ['github_check_run_changed', 'github_commit_status_changed'],
    })
    expect(byType.get('refresh_rules')?.scope).toMatchObject({
      deliveryIds: ['branch-protection', 'repository-ruleset'],
      reasons: ['github_branch_protection_changed', 'github_repository_ruleset_changed'],
    })
    expect(await countJobs(database, fixture.projectId)).toBe(3)
  })

  it('preserves numeric repository identity across rename and transfer metadata updates', async () => {
    const fixture = await seedProject(database, 3)

    await projectWebhook(database, fixture, {
      deliveryId: 'repository-renamed',
      event: 'repository',
      action: 'renamed',
      payload: {},
    })
    await projectWebhook(database, fixture, {
      deliveryId: 'repository-transferred',
      event: 'repository',
      action: 'transferred',
      payload: {},
    })

    const requests = await loadRequests(database, fixture.projectId)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      project_id: fixture.projectId,
      repository_id: String(fixture.repositoryId),
      sync_type: 'refresh_branches',
      scope: {
        deliveryIds: ['repository-renamed', 'repository-transferred'],
        reasons: ['github_repository_renamed', 'github_repository_transferred'],
        refreshMetadata: true,
        requireReconciliation: true,
      },
    })
  })

  it('marks force pushes destructive and schedules installation recovery after unsuspend', async () => {
    const forceFixture = await seedProject(database, 4)
    const recoveryFixture = await seedProject(database, 5)

    await projectWebhook(database, forceFixture, {
      deliveryId: 'source-force-push',
      event: 'push',
      action: null,
      payload: {
        ref: 'refs/heads/develop',
        before: sourceSha,
        after: '2'.repeat(40),
        forced: true,
      },
    })
    await database.kysely.transaction().execute(async (transaction) => {
      await handler({
        transaction,
        deliveryId: 'installation-unsuspended',
        event: 'installation',
        action: 'unsuspend',
        installationId: String(recoveryFixture.installationId),
        repositoryId: null,
        payload: {},
        correlationId: 'webhook:installation-unsuspended',
        causationId: 'github-webhook:installation-unsuspended',
      })
    })

    const forceRequest = (await loadRequests(database, forceFixture.projectId))[0]
    const recoveryRequest = (await loadRequests(database, recoveryFixture.projectId))[0]

    expect(forceRequest?.scope).toMatchObject({
      reasons: ['github_source_branch_pushed'],
      forced: true,
      branchNames: ['develop'],
    })
    expect(recoveryRequest?.scope).toMatchObject({
      installationId: String(recoveryFixture.installationId),
      reasons: ['installation_unsuspended'],
      refreshMetadata: true,
      requireReconciliation: true,
    })
  })
})

async function projectWebhook(
  database: DatabaseClient,
  fixture: ProjectFixture,
  input: {
    readonly deliveryId: string
    readonly event: string
    readonly action: string | null
    readonly payload: JsonValue
  },
): Promise<void> {
  await database.kysely.transaction().execute(async (transaction) => {
    await handler({
      transaction,
      deliveryId: input.deliveryId,
      event: input.event,
      action: input.action,
      installationId: String(fixture.installationId),
      repositoryId: String(fixture.repositoryId),
      payload: input.payload,
      correlationId: `webhook:${input.deliveryId}`,
      causationId: `github-webhook:${input.deliveryId}`,
    })
  })
}

interface ProjectFixture {
  readonly projectId: string
  readonly installationId: number
  readonly repositoryId: number
}

async function seedProject(database: DatabaseClient, index: number): Promise<ProjectFixture> {
  const installationId = 3_000 + index
  const repositoryId = 4_000 + index
  const projectId = `incremental-webhook-project-${index}`
  const now = new Date(`2026-08-05T1${index}:00:00.000Z`)

  await withRepositoryTransaction(database, repositoryId, async ({ transaction }) => {
    await transaction
      .insertInto('projects')
      .values({
        id: projectId,
        installation_id: String(installationId),
        repository_id: String(repositoryId),
        owner_id: '99',
        owner_login: 'octocat',
        repository_name: `shipgate-${index}`,
        repository_full_name: `octocat/shipgate-${index}`,
        default_branch: 'main',
        source_branch: 'develop',
        production_branch: 'main',
        status: 'active',
        source_sha: sourceSha,
        production_sha: productionSha,
        last_successful_sync_at: now,
        merge_base_sha: productionSha,
        configuration_version: 1,
        required_check_policy_version: 0,
        required_check_overrides: '[]',
        deletion_requested_at: null,
        deleted_at: null,
        updated_at: now,
      })
      .execute()
  })

  return { projectId, installationId, repositoryId }
}

async function loadRequests(
  database: DatabaseClient,
  projectId: string,
): Promise<
  readonly {
    readonly project_id: string
    readonly repository_id: string
    readonly sync_type: 'refresh_branches' | 'refresh_change' | 'refresh_checks' | 'refresh_rules'
    readonly status: 'queued' | 'running' | 'succeeded' | 'superseded' | 'failed'
    readonly scope: JsonValue
  }[]
> {
  return database.kysely
    .selectFrom('repository_incremental_sync_requests')
    .select(['project_id', 'repository_id', 'sync_type', 'status', 'scope'])
    .where('project_id', '=', projectId)
    .orderBy('sync_type')
    .execute()
}

async function countJobs(database: DatabaseClient, projectId: string): Promise<number> {
  const requests = await database.kysely
    .selectFrom('repository_incremental_sync_requests')
    .select('id')
    .where('project_id', '=', projectId)
    .execute()
  const requestIds = new Set(requests.map((request) => request.id))
  const jobs = await database.kysely
    .selectFrom('shipgate_job_execution')
    .select('payload')
    .where('task_identifier', 'in', [
      'repository.refresh-branches',
      'repository.refresh-change',
      'repository.refresh-checks',
      'repository.refresh-rules',
    ])
    .execute()

  return jobs.filter((job) => {
    if (!isRecord(job.payload) || !isRecord(job.payload.data)) {
      return false
    }

    const requestId = job.payload.data.requestId
    return typeof requestId === 'string' && requestIds.has(requestId)
  }).length
}

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
