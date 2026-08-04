import { createDatabase, type DatabaseClient, migrateToLatest } from '@shipgate/database'
import { GITHUB_APP_REPOSITORY_PERMISSIONS } from '@shipgate/github'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { GitHubRepositoryAccessService } from '../src/github-access/index.js'
import {
  createProjectService,
  type ProjectTopologyValidator,
  RepositoryAlreadyConnectedError,
  withRepositoryTransaction,
} from '../src/projects/index.js'

const installationId = 123
const repositoryId = 456
const actorGitHubUserId = 99
const productionSha = '1'.repeat(40)
const sourceSha = '2'.repeat(40)
const changedSourceSha = '3'.repeat(40)

describe.sequential('Project configuration persistence', () => {
  let postgres: PostgresTestDatabase
  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    database = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: 'shipgate-project-configuration-test',
      ssl: { mode: 'disable' },
      pool: {
        min: 0,
        max: 4,
        idleTimeoutMs: 5_000,
        connectionTimeoutMs: 5_000,
        maxLifetimeSeconds: 0,
      },
      allowExitOnIdle: true,
      onPoolError: () => undefined,
    })
    await migrateToLatest(database.kysely)
    await seedRepositoryAccess(database)
  }, 60_000)

  afterAll(async () => {
    await database.destroy()
    await postgres.stop()
  })

  it('creates, idempotently configures, invalidates projection, audits, and requests deletion', async () => {
    const service = createProjectService({
      database,
      githubRepositoryAccess: createAccessService(true),
      topologyValidator: createTopologyValidator(),
    })
    const created = await service.create({
      actorGitHubUserId,
      installationId,
      repositoryId,
      sourceBranch: 'develop',
      productionBranch: 'main',
    })

    expect(created).toMatchObject({
      status: 'created',
      project: {
        configurationVersion: 1,
        sourceBranch: 'develop',
        productionBranch: 'main',
        sourceSha,
        productionSha,
      },
      reconciliation: {
        status: 'queued',
        reason: 'project_created',
        mode: 'full',
      },
    })

    await expect(
      service.create({
        actorGitHubUserId,
        installationId,
        repositoryId,
        sourceBranch: 'release',
        productionBranch: 'main',
      }),
    ).rejects.toBeInstanceOf(RepositoryAlreadyConnectedError)

    const same = await service.update({
      actorGitHubUserId,
      projectId: created.project.id,
      expectedConfigurationVersion: 1,
      sourceBranch: 'develop',
    })
    expect(same).toMatchObject({ status: 'already_applied', reconciliation: null })
    await seedProjection(database, created.project.id)

    const updated = await service.update({
      actorGitHubUserId,
      projectId: created.project.id,
      expectedConfigurationVersion: 1,
      sourceBranch: 'release',
    })
    expect(updated).toMatchObject({
      status: 'updated',
      project: {
        configurationVersion: 2,
        sourceBranch: 'release',
        sourceSha: changedSourceSha,
        lastSuccessfulSyncAt: null,
      },
      reconciliation: {
        status: 'queued',
        reason: 'project_configuration_changed',
        mode: 'full',
      },
    })

    expect(await count(database, 'repository_branches')).toBe(0)
    expect(await count(database, 'repository_commits')).toBe(0)
    expect(await count(database, 'change_commits')).toBe(0)
    const change = await database.kysely
      .selectFrom('changes')
      .select(['synchronization_state', 'production_presence', 'commit_set_fingerprint'])
      .where('project_id', '=', created.project.id)
      .executeTakeFirstOrThrow()
    expect(change).toEqual({
      synchronization_state: 'unknown',
      production_presence: 'unknown',
      commit_set_fingerprint: null,
    })
    expect(await count(database, 'project_audit_events')).toBe(2)
    expect(await count(database, 'repository_reconciliation_requests')).toBe(2)

    const deleted = await service.delete({
      actorGitHubUserId,
      projectId: created.project.id,
      expectedConfigurationVersion: 2,
    })
    expect(deleted).toMatchObject({ status: 'pending_deletion', configurationVersion: 3 })
    expect(await count(database, 'project_audit_events')).toBe(3)
    const activeRequests = await database.kysely
      .selectFrom('repository_reconciliation_requests')
      .select('id')
      .where('project_id', '=', created.project.id)
      .where('status', 'in', ['queued', 'claimed'])
      .execute()
    expect(activeRequests).toEqual([])
  })

  it('requires Maintain or Admin permission', async () => {
    const service = createProjectService({
      database,
      githubRepositoryAccess: createAccessService(false),
      topologyValidator: createTopologyValidator(),
    })

    await expect(
      service.create({
        actorGitHubUserId,
        installationId: 124,
        repositoryId: 457,
        sourceBranch: 'develop',
        productionBranch: 'main',
      }),
    ).rejects.toMatchObject({ code: 'permission_missing' })
  })
})

function createAccessService(allowed: boolean): GitHubRepositoryAccessService {
  return {
    async reconcileUserInstallations() {
      return []
    },
    async authorizeRepositoryAccess(input) {
      return {
        allowed,
        reason: allowed ? 'allowed' : 'insufficient_repository_permission',
        githubUserId: input.githubUserId,
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        repositoryPermission: allowed ? 'maintain' : 'write',
        requiredPermission: input.requiredPermission,
        verifiedAt: new Date(),
        cacheExpiresAt: new Date(Date.now() + 60_000),
      }
    },
    invalidateAll() {},
    invalidateInstallation() {},
    invalidateUser() {},
  }
}

function createTopologyValidator(): ProjectTopologyValidator {
  return {
    async validate(input) {
      return {
        ...input,
        ownerId: actorGitHubUserId,
        ownerLogin: 'octocat',
        repositoryName: 'shipgate',
        repositoryFullName: 'octocat/shipgate',
        cloneUrl: 'https://github.com/octocat/shipgate.git',
        defaultBranch: 'main',
        sourceSha: input.sourceBranch === 'release' ? changedSourceSha : sourceSha,
        productionSha,
        compareStatus: 'ahead',
      }
    },
  }
}

async function seedRepositoryAccess(database: DatabaseClient): Promise<void> {
  const now = new Date('2026-08-04T00:00:00.000Z')
  await database.kysely
    .insertInto('github_installations')
    .values({
      installation_id: String(installationId),
      owner_id: String(actorGitHubUserId),
      owner_type: 'User',
      owner_login: 'octocat',
      owner_avatar_url: null,
      repository_selection: 'selected',
      suspended_at: null,
      permission_state: 'current',
      lifecycle_state: 'active',
      deletion_requested_at: null,
      deleted_at: null,
      last_successful_confirmation_at: now,
      last_reconciled_at: now,
      updated_at: now,
    })
    .execute()
  await database.kysely
    .insertInto('github_installation_repositories')
    .values({
      installation_id: String(installationId),
      repository_id: String(repositoryId),
      owner_id: String(actorGitHubUserId),
      owner_login: 'octocat',
      name: 'shipgate',
      full_name: 'octocat/shipgate',
      private: true,
      archived: false,
      disabled: false,
      default_branch: 'main',
      visibility: 'private',
      last_successful_confirmation_at: now,
      last_reconciled_at: now,
      updated_at: now,
    })
    .execute()
  await database.kysely
    .insertInto('github_installation_permissions')
    .values(
      Object.entries(GITHUB_APP_REPOSITORY_PERMISSIONS).map(([name, level]) => ({
        installation_id: String(installationId),
        permission_name: name,
        permission_level: level,
        last_reconciled_at: now,
        updated_at: now,
      })),
    )
    .execute()
}

async function seedProjection(database: DatabaseClient, projectId: string): Promise<void> {
  const now = new Date('2026-08-04T00:10:00.000Z')
  await withRepositoryTransaction(database, repositoryId, async ({ transaction }) => {
    await transaction
      .insertInto('repository_branches')
      .values({
        project_id: projectId,
        repository_id: String(repositoryId),
        name: 'develop',
        head_sha: sourceSha,
        protected: false,
        default_branch: false,
        observed_at: now,
        updated_at: now,
      })
      .execute()
    await transaction
      .insertInto('repository_commits')
      .values({
        project_id: projectId,
        repository_id: String(repositoryId),
        sha: sourceSha,
        tree_sha: null,
        message: 'source',
        author_id: null,
        author_login: null,
        author_name: null,
        author_email: null,
        committer_id: null,
        committer_login: null,
        authored_at: now,
        committed_at: now,
        parent_shas: JSON.stringify([productionSha]),
        source_delta_position: 0,
        observed_at: now,
        updated_at: now,
      })
      .execute()
    await transaction
      .insertInto('changes')
      .values({
        id: 'change-before-reconfiguration',
        project_id: projectId,
        repository_id: String(repositoryId),
        github_pull_request_id: '7001',
        pull_request_number: 42,
        title: 'Existing change',
        url: null,
        author_id: null,
        author_login: null,
        base_branch: 'develop',
        merged_at: now,
        final_head_sha: sourceSha,
        merge_commit_sha: sourceSha,
        source_integration_sha: sourceSha,
        merge_method: 'squash',
        commit_set_fingerprint: '4'.repeat(64),
        synchronization_state: 'known',
        production_presence: 'missing',
        observed_at: now,
        updated_at: now,
      })
      .execute()
    await transaction
      .insertInto('change_commits')
      .values({
        project_id: projectId,
        repository_id: String(repositoryId),
        change_id: 'change-before-reconfiguration',
        commit_sha: sourceSha,
        position: 0,
      })
      .execute()
  })
}

async function count(
  database: DatabaseClient,
  table:
    | 'repository_branches'
    | 'repository_commits'
    | 'change_commits'
    | 'project_audit_events'
    | 'repository_reconciliation_requests',
): Promise<number> {
  const row = await database.kysely
    .selectFrom(table)
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow()

  return Number(row.count)
}
