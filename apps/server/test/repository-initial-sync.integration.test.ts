import { createDatabase, type DatabaseClient, migrateToLatest } from '@shipgate/database'
import {
  GITHUB_APP_REPOSITORY_PERMISSIONS,
  type GitHubAuthenticationService,
  type GitHubInstallationTokenLease,
  type GitHubResponse,
  type InstallationGitHubClient,
  type InstallationPermissions,
} from '@shipgate/github'
import {
  migrateJobQueue,
  PermanentJobError,
  RetryableJobError,
  type StructuredLogger,
} from '@shipgate/jobs'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { GitHubRepositoryAccessService } from '../src/github-access/index.js'
import {
  createProjectService,
  createRepositoryInitialSyncHandler,
  type ProjectTopologyValidator,
  queueRepositoryInitialSync,
  type ReadOnlyGitWorkspace,
  withRepositoryTransaction,
} from '../src/projects/index.js'

const productionSha = '1'.repeat(40)
const sourceSha = '2'.repeat(40)
const movedSourceSha = '3'.repeat(40)
const treeSha = '4'.repeat(40)

const logger: StructuredLogger = {
  child() {
    return logger
  },
  debug() {},
  info() {},
  warn() {},
  error() {},
}

describe.sequential('Repository initial synchronization', () => {
  let postgres: PostgresTestDatabase
  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    database = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: 'shipgate-repository-initial-sync-test',
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
    await migrateJobQueue(database)
    await migrateToLatest(database.kysely)
    await seedRepositoryAccess(database, 123, 456)
    await seedRepositoryAccess(database, 124, 457)
  }, 60_000)

  afterAll(async () => {
    await database.destroy()
    await postgres.stop()
  })

  it('publishes one coherent snapshot and safely replays the same job', async () => {
    const githubAuth = createGitHubAuth({ installationId: 123, repositoryId: 456 })
    const service = createProjectService({
      database,
      githubRepositoryAccess: createAccessService(),
      topologyValidator: createTopologyValidator(123, 456),
    })
    const created = await service.create({
      actorGitHubUserId: 99,
      installationId: 123,
      repositoryId: 456,
      sourceBranch: 'develop',
      productionBranch: 'main',
      correlationId: 'test:initial-sync:create',
    })
    const handler = createRepositoryInitialSyncHandler({
      database,
      githubAuth,
      gitWorkspace: createGitWorkspace(sourceSha),
    })
    const requestId = created.reconciliation?.id

    if (!requestId) {
      throw new Error('Expected an initial synchronization request')
    }

    const queuedJob = await sql<{ readonly task_identifier: string }>`
      select task_identifier
      from graphile_worker.jobs
      where key = ${`repository.reconcile:${requestId}`}
    `.execute(database.kysely)
    expect(queuedJob.rows).toEqual([{ task_identifier: 'repository.reconcile' }])

    await expect(
      handler({
        requestId,
        attempt: 1,
        maxAttempts: 10,
        correlationId: 'test:initial-sync:run',
        causationId: `request:${requestId}`,
        signal: new AbortController().signal,
        logger,
      }),
    ).resolves.toMatchObject({ status: 'applied', sourceSha, productionSha })

    const project = await database.kysely
      .selectFrom('projects')
      .select([
        'status',
        'source_sha',
        'production_sha',
        'merge_base_sha',
        'last_successful_sync_at',
      ])
      .where('id', '=', created.project.id)
      .executeTakeFirstOrThrow()
    expect(project).toMatchObject({
      status: 'active',
      source_sha: sourceSha,
      production_sha: productionSha,
      merge_base_sha: productionSha,
      last_successful_sync_at: expect.any(Date),
    })
    expect(await count(database, 'repository_commits', created.project.id)).toBe(1)
    expect(await count(database, 'changes', created.project.id)).toBe(1)
    expect(await count(database, 'required_checks', created.project.id)).toBe(1)
    expect(await count(database, 'commit_check_results', created.project.id)).toBe(1)

    const persistedCommit = await database.kysely
      .selectFrom('repository_commits')
      .select([
        'sha',
        'first_parent_position',
        'integration_point_sha',
        'production_patch_equivalent',
        'attribution_state',
      ])
      .where('project_id', '=', created.project.id)
      .executeTakeFirstOrThrow()
    expect(persistedCommit).toEqual({
      sha: sourceSha,
      first_parent_position: 0,
      integration_point_sha: sourceSha,
      production_patch_equivalent: false,
      attribution_state: 'managed',
    })

    const persistedChange = await database.kysely
      .selectFrom('changes')
      .select([
        'merge_method',
        'source_integration_sha',
        'integration_first_parent_sha',
        'integration_second_parent_sha',
        'production_presence',
      ])
      .where('project_id', '=', created.project.id)
      .executeTakeFirstOrThrow()
    expect(persistedChange).toEqual({
      merge_method: 'squash',
      source_integration_sha: sourceSha,
      integration_first_parent_sha: productionSha,
      integration_second_parent_sha: null,
      production_presence: 'unreleased',
    })

    await expect(
      handler({
        requestId,
        attempt: 2,
        maxAttempts: 10,
        correlationId: 'test:initial-sync:replay',
        causationId: `request:${requestId}`,
        signal: new AbortController().signal,
        logger,
      }),
    ).resolves.toMatchObject({ status: 'succeeded', requestId })

    expect(await count(database, 'repository_commits', created.project.id)).toBe(1)
    expect(await count(database, 'changes', created.project.id)).toBe(1)

    const retryRequest = await withRepositoryTransaction(database, 456, ({ transaction }) =>
      queueRepositoryInitialSync({
        transaction,
        projectId: created.project.id,
        repositoryId: '456',
        configurationVersion: 1,
        reason: 'test_transient_failure',
        requestedByGitHubUserId: null,
        sourceSha,
        productionSha,
        idempotencyKey: `test-transient:${created.project.id}:1`,
        correlationId: 'test:initial-sync:transient',
        causationId: `project:${created.project.id}:transient`,
        now: new Date('2026-08-04T11:00:00.000Z'),
      }),
    )
    const failingHandler = createRepositoryInitialSyncHandler({
      database,
      githubAuth: createFailingGitHubAuth(503),
      gitWorkspace: createGitWorkspace(sourceSha),
    })

    await expect(
      failingHandler({
        requestId: retryRequest.id,
        attempt: 1,
        maxAttempts: 10,
        correlationId: 'test:initial-sync:transient-attempt',
        causationId: `request:${retryRequest.id}`,
        signal: new AbortController().signal,
        logger,
      }),
    ).rejects.toBeInstanceOf(RetryableJobError)

    const afterTransientFailure = await database.kysely
      .selectFrom('projects')
      .select(['status', 'source_sha', 'production_sha', 'last_successful_sync_at'])
      .where('id', '=', created.project.id)
      .executeTakeFirstOrThrow()
    expect(afterTransientFailure).toMatchObject({
      status: 'active',
      source_sha: sourceSha,
      production_sha: productionSha,
      last_successful_sync_at: project.last_successful_sync_at,
    })
    expect(await count(database, 'repository_commits', created.project.id)).toBe(1)
    expect(await count(database, 'changes', created.project.id)).toBe(1)

    await expect(
      failingHandler({
        requestId: retryRequest.id,
        attempt: 10,
        maxAttempts: 10,
        correlationId: 'test:initial-sync:exhausted',
        causationId: `request:${retryRequest.id}`,
        signal: new AbortController().signal,
        logger,
      }),
    ).rejects.toBeInstanceOf(PermanentJobError)

    const afterExhaustion = await database.kysely
      .selectFrom('projects')
      .select(['status', 'source_sha', 'production_sha', 'last_successful_sync_at'])
      .where('id', '=', created.project.id)
      .executeTakeFirstOrThrow()
    expect(afterExhaustion).toMatchObject({
      status: 'degraded',
      source_sha: sourceSha,
      production_sha: productionSha,
      last_successful_sync_at: project.last_successful_sync_at,
    })
    expect(await count(database, 'repository_commits', created.project.id)).toBe(1)
    expect(await count(database, 'changes', created.project.id)).toBe(1)
  })

  it('supersedes a stale snapshot and durably queues current branch heads', async () => {
    const githubAuth = createGitHubAuth({
      installationId: 124,
      repositoryId: 457,
      moveSourceAfterFirstObservation: true,
    })
    const service = createProjectService({
      database,
      githubRepositoryAccess: createAccessService(),
      topologyValidator: createTopologyValidator(124, 457),
    })
    const created = await service.create({
      actorGitHubUserId: 99,
      installationId: 124,
      repositoryId: 457,
      sourceBranch: 'develop',
      productionBranch: 'main',
      correlationId: 'test:superseded:create',
    })
    const handler = createRepositoryInitialSyncHandler({
      database,
      githubAuth,
      gitWorkspace: createGitWorkspace(sourceSha),
    })
    const requestId = created.reconciliation?.id

    if (!requestId) {
      throw new Error('Expected an initial synchronization request')
    }

    await expect(
      handler({
        requestId,
        attempt: 1,
        maxAttempts: 10,
        correlationId: 'test:superseded:run',
        causationId: `request:${requestId}`,
        signal: new AbortController().signal,
        logger,
      }),
    ).resolves.toMatchObject({
      status: 'superseded',
      requestId,
      sourceSha: movedSourceSha,
    })

    const requests = await database.kysely
      .selectFrom('repository_reconciliation_requests')
      .select(['id', 'status', 'source_sha', 'superseded_by_request_id'])
      .where('project_id', '=', created.project.id)
      .orderBy('requested_at')
      .execute()
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      id: requestId,
      status: 'superseded',
      superseded_by_request_id: requests[1]?.id,
    })
    expect(requests[1]).toMatchObject({ status: 'queued', source_sha: movedSourceSha })
    expect(await count(database, 'repository_commits', created.project.id)).toBe(0)
  })
})

function createGitHubAuth(input: {
  readonly installationId: number
  readonly repositoryId: number
  readonly moveSourceAfterFirstObservation?: boolean
}): GitHubAuthenticationService {
  let sourceRefReads = 0
  const client: InstallationGitHubClient = {
    authentication: {
      type: 'installation',
      installationId: input.installationId,
      repositoryIds: [input.repositoryId],
      permissions: GITHUB_APP_REPOSITORY_PERMISSIONS,
    },
    async request<Data = unknown>(route: string, parameters?: Readonly<Record<string, unknown>>) {
      if (route === 'GET /repositories/{repository_id}') {
        return response<Data>({
          id: input.repositoryId,
          name: 'shipgate',
          full_name: 'octocat/shipgate',
          clone_url: 'https://github.com/octocat/shipgate.git',
          default_branch: 'main',
          archived: false,
          disabled: false,
          owner: { id: 99, login: 'octocat' },
        })
      }

      if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
        const ref = String(parameters?.ref)
        const source = ref === 'heads/develop'
        if (source) sourceRefReads += 1
        const sha =
          source && input.moveSourceAfterFirstObservation && sourceRefReads > 1
            ? movedSourceSha
            : source
              ? sourceSha
              : productionSha
        return response<Data>({ ref: `refs/${ref}`, object: { type: 'commit', sha } })
      }

      if (route === 'GET /repos/{owner}/{repo}/branches/{branch}') {
        const branch = String(parameters?.branch)
        const branchSha =
          branch === 'develop' && input.moveSourceAfterFirstObservation && sourceRefReads > 1
            ? movedSourceSha
            : branch === 'develop'
              ? sourceSha
              : productionSha
        return response<Data>({
          protected: branch === 'main',
          commit: { sha: branchSha },
        })
      }

      if (route === 'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls') {
        return response<Data>([
          {
            id: 7001,
            number: 42,
            title: 'Ship the projection',
            html_url: 'https://github.example/octocat/shipgate/pull/42',
            merged_at: '2026-08-04T10:00:00.000Z',
            merge_commit_sha: sourceSha,
            commits: 2,
            user: { id: 99, login: 'octocat' },
            base: { ref: 'develop' },
            head: { sha: '5'.repeat(40) },
          },
        ])
      }

      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return response<Data>({
          id: 7001,
          number: 42,
          title: 'Ship the projection',
          html_url: 'https://github.example/octocat/shipgate/pull/42',
          merged_at: '2026-08-04T10:00:00.000Z',
          merge_commit_sha: sourceSha,
          commits: 2,
          user: { id: 99, login: 'octocat' },
          base: { ref: 'develop' },
          head: { sha: '5'.repeat(40) },
        })
      }

      if (
        route === 'GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks'
      ) {
        return response<Data>({ contexts: ['ci/test'], checks: [] })
      }

      if (route === 'GET /repos/{owner}/{repo}/rules/branches/{branch}') {
        return response<Data>([])
      }

      if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs') {
        return response<Data>({
          check_runs: [
            {
              id: 8001,
              name: 'ci/test',
              status: 'completed',
              conclusion: 'success',
              details_url: 'https://github.example/checks/8001',
              started_at: '2026-08-04T10:01:00.000Z',
              completed_at: '2026-08-04T10:02:00.000Z',
              app: { id: 9001 },
            },
          ],
        })
      }

      if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/statuses') {
        return response<Data>([])
      }

      throw new Error(`Unexpected GitHub route: ${route}`)
    },
    async graphql<Data = unknown>(
      query: string,
      parameters?: Readonly<Record<string, unknown>>,
    ): Promise<Data> {
      if (query.includes('ShipgateAssociatedPullRequests')) {
        return {
          repository: {
            object: {
              associatedPullRequests: {
                nodes: [
                  {
                    number: 42,
                    merged: true,
                    mergedAt: '2026-08-04T10:00:00.000Z',
                    baseRefName: 'develop',
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        } as Data
      }

      if (query.includes('ShipgatePullRequestCommits')) {
        expect(parameters?.number).toBe(42)
        return {
          repository: {
            pullRequest: {
              commits: {
                nodes: [{ commit: { oid: '4'.repeat(40) } }, { commit: { oid: '5'.repeat(40) } }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        } as Data
      }

      return {} as Data
    },
  }

  return {
    async getAppClient() {
      throw new Error('not used')
    },
    async getInstallationClient() {
      return client
    },
    async withInstallationToken<Result>(
      _input: {
        readonly installationId: number
        readonly repositoryIds?: number[]
        readonly permissions?: InstallationPermissions
      },
      callback: (lease: GitHubInstallationTokenLease) => Promise<Result>,
    ): Promise<Result> {
      return callback({ token: 'installation-token', expiresAt: new Date(Date.now() + 60_000) })
    },
    async getUserClient() {
      throw new Error('not used')
    },
    async authorizeUser() {
      throw new Error('not used')
    },
    invalidateInstallation() {},
    invalidateUser() {},
    async revokeUser() {},
    async disconnectUser() {},
  } satisfies GitHubAuthenticationService
}

function createFailingGitHubAuth(status: number): GitHubAuthenticationService {
  const error = Object.assign(new Error(`GitHub returned ${status}`), {
    status,
    code: 'service_unavailable',
  })

  return {
    async getAppClient() {
      throw error
    },
    async getInstallationClient() {
      throw error
    },
    async withInstallationToken() {
      throw error
    },
    async getUserClient() {
      throw error
    },
    async authorizeUser() {
      throw error
    },
    invalidateInstallation() {},
    invalidateUser() {},
    async revokeUser() {},
    async disconnectUser() {},
  } satisfies GitHubAuthenticationService
}

function createGitWorkspace(expectedSourceSha: string): ReadOnlyGitWorkspace {
  return {
    async assertProductionAncestor() {},
    async loadRepositorySnapshot(input) {
      expect(input.sourceSha).toBe(expectedSourceSha)
      expect(input.productionSha).toBe(productionSha)
      return {
        sourceSha: input.sourceSha,
        productionSha: input.productionSha,
        mergeBaseSha: input.productionSha,
        firstParentShas: [input.sourceSha],
        integrationWindows: [
          {
            integrationSha: input.sourceSha,
            firstParentSha: input.productionSha,
            secondParentSha: null,
            firstParentPosition: 0,
            commitShas: [input.sourceSha],
            introducedCommitShas: [],
          },
        ],
        commits: [
          {
            sha: input.sourceSha,
            treeSha,
            message: 'feat: ship projection',
            authorName: 'Octocat',
            authorEmail: 'octocat@example.com',
            authoredAt: new Date('2026-08-04T09:59:00.000Z'),
            committerName: 'Octocat',
            committerEmail: 'octocat@example.com',
            committedAt: new Date('2026-08-04T10:00:00.000Z'),
            parentShas: [productionSha],
            sourceDeltaPosition: 0,
            firstParentPosition: 0,
            integrationPointSha: input.sourceSha,
            productionPatchEquivalent: false,
          },
        ],
      }
    },
  }
}

function createTopologyValidator(
  installationId: number,
  repositoryId: number,
): ProjectTopologyValidator {
  return {
    async validate(input: Parameters<ProjectTopologyValidator['validate']>[0]) {
      return {
        ...input,
        installationId,
        repositoryId,
        ownerId: 99,
        ownerLogin: 'octocat',
        repositoryName: 'shipgate',
        repositoryFullName: 'octocat/shipgate',
        cloneUrl: 'https://github.com/octocat/shipgate.git',
        defaultBranch: 'main',
        sourceSha,
        productionSha,
        compareStatus: 'ahead',
      }
    },
  }
}

function createAccessService(): GitHubRepositoryAccessService {
  return {
    async reconcileUserInstallations() {
      return []
    },
    async authorizeRepositoryAccess(
      input: Parameters<GitHubRepositoryAccessService['authorizeRepositoryAccess']>[0],
    ) {
      return {
        allowed: true,
        reason: 'allowed',
        githubUserId: input.githubUserId,
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        repositoryPermission: 'maintain',
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

async function seedRepositoryAccess(
  database: DatabaseClient,
  installationId: number,
  repositoryId: number,
): Promise<void> {
  const now = new Date('2026-08-04T00:00:00.000Z')
  await database.kysely
    .insertInto('github_installations')
    .values({
      installation_id: String(installationId),
      owner_id: '99',
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
      owner_id: '99',
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

async function count(
  database: DatabaseClient,
  table: 'repository_commits' | 'changes' | 'required_checks' | 'commit_check_results',
  projectId: string,
): Promise<number> {
  const row = await database.kysely
    .selectFrom(table)
    .select(sql<number>`count(*)::integer`.as('count'))
    .where('project_id', '=', projectId)
    .executeTakeFirstOrThrow()
  return Number(row.count)
}

function response<Data>(data: unknown): GitHubResponse<Data> {
  return {
    data: data as Data,
    status: 200,
    headers: {},
    url: 'https://api.github.test/fixture',
  }
}
