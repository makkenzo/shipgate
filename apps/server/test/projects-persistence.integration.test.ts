import {
  createDatabase,
  type DatabaseClient,
  DatabaseOperationError,
  migrateToLatest,
} from '@shipgate/database'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  applyRepositoryProjection,
  createProject,
  getProject,
  listChangesAheadOfProduction,
  listUnmanagedCommits,
  RepositoryAlreadyConnectedError,
  RepositoryProjectionInvariantError,
  recordRepositorySyncFailure,
  withRepositoryTransaction,
} from '../src/projects/index.js'

const installationId = 123
const repositoryId = 456
const ownerId = 99
const projectId = 'project-repository-projection'

const productionSha = '1'.repeat(40)
const changeCommitSha = '2'.repeat(40)
const sourceSha = '3'.repeat(40)
const changeFingerprint = '4'.repeat(64)
const projectionFingerprint = '5'.repeat(64)

const observedAt = new Date('2026-08-03T20:00:00.000Z')
const startedAt = new Date('2026-08-03T19:59:55.000Z')
const completedAt = new Date('2026-08-03T20:00:01.000Z')

describe.sequential('Project repository projection persistence', () => {
  let postgres: PostgresTestDatabase
  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    database = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: 'shipgate-project-projection-test',
      ssl: {
        mode: 'disable',
      },
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

  it('creates one non-deleted project per GitHub repository under the repository lock', async () => {
    const project = await createProject(database, {
      projectId,
      installationId,
      repositoryId,
      sourceBranch: 'develop',
      productionBranch: 'main',
      now: startedAt,
    })

    expect(project).toMatchObject({
      id: projectId,
      installationId: String(installationId),
      repositoryId: String(repositoryId),
      ownerId: String(ownerId),
      ownerLogin: 'octocat',
      repositoryFullName: 'octocat/shipgate',
      sourceBranch: 'develop',
      productionBranch: 'main',
      status: 'active',
      sourceSha: null,
      productionSha: null,
      configurationVersion: 1,
    })

    await expect(
      createProject(database, {
        installationId,
        repositoryId,
        sourceBranch: 'staging',
        productionBranch: 'main',
      }),
    ).rejects.toBeInstanceOf(RepositoryAlreadyConnectedError)
  })

  it('keeps GitHub repository identity immutable inside the lock boundary', async () => {
    const error = await withRepositoryTransaction(
      database,
      repositoryId,
      async ({ transaction }) => {
        await transaction
          .updateTable('projects')
          .set({
            repository_id: '457',
          })
          .where('id', '=', projectId)
          .execute()
      },
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(DatabaseOperationError)

    if (!(error instanceof DatabaseOperationError)) {
      throw new Error('Expected repository identity update to fail with DatabaseOperationError')
    }

    expect(error).toMatchObject({
      operation: `projects.repository-transaction:${repositoryId}`,
      sqlState: 'P0001',
    })
    expect(error.cause).toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('repository identity is immutable'),
    })
  })

  it('rejects projection writes outside a repository transaction and lock', async () => {
    await expect(
      database.kysely
        .insertInto('repository_branches')
        .values({
          project_id: projectId,
          repository_id: String(repositoryId),
          name: 'outside-lock',
          head_sha: productionSha,
          protected: false,
          default_branch: false,
          observed_at: observedAt,
        })
        .execute(),
    ).rejects.toThrow('repository projection write requires a repository transaction and lock')
  })

  it('atomically stores a coherent projection and answers the source delta', async () => {
    const first = await applyRepositoryProjection(database, {
      projectId,
      repositoryId,
      expectedConfigurationVersion: 1,
      reason: 'initial',
      idempotencyKey: 'projection:initial:1',
      projectionFingerprint,
      startedAt,
      completedAt,
      snapshot: createSnapshot(),
    })

    expect(first.status).toBe('applied')
    expect(first.project).toMatchObject({
      ownerLogin: 'octocat-renamed',
      repositoryFullName: 'octocat-renamed/shipgate',
      sourceSha,
      productionSha,
      status: 'active',
      lastSuccessfulSyncAt: completedAt,
    })

    const repeated = await applyRepositoryProjection(database, {
      projectId,
      repositoryId,
      expectedConfigurationVersion: 1,
      reason: 'initial',
      idempotencyKey: 'projection:initial:1',
      projectionFingerprint,
      startedAt,
      completedAt,
      snapshot: createSnapshot(),
    })

    expect(repeated).toMatchObject({
      status: 'already_applied',
      syncRunId: first.syncRunId,
    })

    const changes = await listChangesAheadOfProduction(database, projectId)

    expect(changes).toEqual([
      expect.objectContaining({
        githubPullRequestId: '7001',
        pullRequestNumber: 42,
        title: 'Add repository projection',
        authorId: '101',
        authorLogin: 'contributor',
        mergeMethod: 'squash',
        commitSetFingerprint: changeFingerprint,
        productionPresence: 'missing',
        commitShas: [changeCommitSha],
      }),
    ])

    const unmanaged = await listUnmanagedCommits(database, projectId)

    expect(unmanaged).toEqual([
      expect.objectContaining({
        sha: sourceSha,
        message: 'Direct commit on source',
        sourceDeltaPosition: 1,
      }),
    ])

    const counts = await Promise.all([
      countRows(database, 'repository_branches'),
      countRows(database, 'repository_commits'),
      countRows(database, 'changes'),
      countRows(database, 'change_commits'),
      countRows(database, 'required_checks'),
      countRows(database, 'commit_check_results'),
      countRows(database, 'repository_sync_runs'),
      countRows(database, 'repository_sync_issues'),
    ])

    expect(counts).toEqual([2, 3, 1, 1, 1, 1, 1, 1])
  })

  it('rejects a source commit attributed to two changes before persistence', async () => {
    const snapshot = createSnapshot()
    const [firstChange] = snapshot.changes

    if (!firstChange) {
      throw new Error('Snapshot fixture must contain at least one change')
    }

    await expect(
      applyRepositoryProjection(database, {
        projectId,
        repositoryId,
        expectedConfigurationVersion: 1,
        reason: 'manual',
        idempotencyKey: 'projection:invalid-double-attribution',
        projectionFingerprint: '6'.repeat(64),
        startedAt,
        completedAt,
        snapshot: {
          ...snapshot,
          changes: [
            ...snapshot.changes,
            {
              ...firstChange,
              id: 'second-change',
              githubPullRequestId: 7002,
              pullRequestNumber: 43,
              title: 'Conflicting change',
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(RepositoryProjectionInvariantError)
  })

  it('enforces one Change owner for each source commit in PostgreSQL', async () => {
    await expect(
      withRepositoryTransaction(database, repositoryId, async ({ transaction }) => {
        await transaction
          .insertInto('changes')
          .values({
            id: 'database-conflicting-change',
            project_id: projectId,
            repository_id: String(repositoryId),
            github_pull_request_id: '7003',
            pull_request_number: 44,
            title: 'Database-level conflict probe',
            url: null,
            author_id: '103',
            author_login: 'database-probe',
            base_branch: 'develop',
            merged_at: observedAt,
            final_head_sha: changeCommitSha,
            merge_commit_sha: changeCommitSha,
            source_integration_sha: changeCommitSha,
            merge_method: 'squash',
            commit_set_fingerprint: '7'.repeat(64),
            synchronization_state: 'known',
            production_presence: 'missing',
            observed_at: observedAt,
            updated_at: observedAt,
          })
          .execute()

        await transaction
          .insertInto('change_commits')
          .values({
            project_id: projectId,
            repository_id: String(repositoryId),
            change_id: 'database-conflicting-change',
            commit_sha: changeCommitSha,
            position: 0,
          })
          .execute()
      }),
    ).rejects.toThrow()

    const conflictingChange = await database.kysely
      .selectFrom('changes')
      .select('id')
      .where('id', '=', 'database-conflicting-change')
      .executeTakeFirst()

    expect(conflictingChange).toBeUndefined()
  })

  it('records synchronization problems without destroying the last successful snapshot', async () => {
    const result = await recordRepositorySyncFailure(database, {
      projectId,
      repositoryId,
      expectedConfigurationVersion: 1,
      reason: 'webhook:push',
      idempotencyKey: 'projection:failed:1',
      startedAt: new Date('2026-08-03T20:10:00.000Z'),
      completedAt: new Date('2026-08-03T20:10:02.000Z'),
      errorCode: 'repository_unreachable',
      errorMessage: 'GitHub returned 503',
      issues: [
        {
          severity: 'error',
          code: 'repository_unreachable',
          scope: 'repository',
          subjectId: String(repositoryId),
          message: 'Repository state could not be verified',
          details: {
            status: 503,
          },
        },
      ],
      disconnectProject: true,
    })

    expect(result.status).toBe('recorded')

    const project = await getProject(database, projectId)
    expect(project).toMatchObject({
      status: 'disconnected',
      sourceSha,
      productionSha,
      lastSuccessfulSyncAt: completedAt,
    })

    expect(await countRows(database, 'repository_commits')).toBe(3)
    expect(await countRows(database, 'repository_sync_runs')).toBe(2)
    expect(await countRows(database, 'repository_sync_issues')).toBe(2)
  })
})

function createSnapshot() {
  return {
    installationId,
    ownerId,
    ownerLogin: 'octocat-renamed',
    repositoryName: 'shipgate',
    repositoryFullName: 'octocat-renamed/shipgate',
    defaultBranch: 'main',
    sourceSha,
    productionSha,
    observedAt,
    branches: [
      {
        name: 'develop',
        headSha: sourceSha,
        protected: true,
        defaultBranch: false,
      },
      {
        name: 'main',
        headSha: productionSha,
        protected: true,
        defaultBranch: true,
      },
    ],
    commits: [
      {
        sha: productionSha,
        treeSha: 'a'.repeat(40),
        message: 'Production base',
        authorId: ownerId,
        authorLogin: 'octocat',
        authorName: 'The Octocat',
        authorEmail: null,
        committerId: ownerId,
        committerLogin: 'octocat',
        authoredAt: new Date('2026-08-03T19:00:00.000Z'),
        committedAt: new Date('2026-08-03T19:00:00.000Z'),
        parentShas: [],
        sourceDeltaPosition: null,
      },
      {
        sha: changeCommitSha,
        treeSha: 'b'.repeat(40),
        message: 'Add repository projection',
        authorId: 101,
        authorLogin: 'contributor',
        authorName: 'Contributor',
        authorEmail: null,
        committerId: ownerId,
        committerLogin: 'octocat',
        authoredAt: new Date('2026-08-03T19:10:00.000Z'),
        committedAt: new Date('2026-08-03T19:20:00.000Z'),
        parentShas: [productionSha],
        sourceDeltaPosition: 0,
      },
      {
        sha: sourceSha,
        treeSha: 'c'.repeat(40),
        message: 'Direct commit on source',
        authorId: 102,
        authorLogin: 'operator',
        authorName: 'Operator',
        authorEmail: null,
        committerId: 102,
        committerLogin: 'operator',
        authoredAt: new Date('2026-08-03T19:30:00.000Z'),
        committedAt: new Date('2026-08-03T19:30:00.000Z'),
        parentShas: [changeCommitSha],
        sourceDeltaPosition: 1,
      },
    ],
    changes: [
      {
        id: 'change-42',
        githubPullRequestId: 7001,
        pullRequestNumber: 42,
        title: 'Add repository projection',
        url: 'https://github.example/octocat/shipgate/pull/42',
        authorId: 101,
        authorLogin: 'contributor',
        baseBranch: 'develop',
        mergedAt: new Date('2026-08-03T19:20:00.000Z'),
        finalHeadSha: changeCommitSha,
        mergeCommitSha: changeCommitSha,
        sourceIntegrationSha: changeCommitSha,
        mergeMethod: 'squash' as const,
        commitSetFingerprint: changeFingerprint,
        synchronizationState: 'known' as const,
        productionPresence: 'missing' as const,
        commitShas: [changeCommitSha],
      },
    ],
    requiredChecks: [
      {
        id: 'required-check-ci',
        policyVersion: 1,
        type: 'check_run' as const,
        context: 'ci',
        integrationId: 9001,
        source: 'repository_ruleset' as const,
        sourceReference: 'ruleset:100',
      },
    ],
    checkResults: [
      {
        id: 'check-result-ci',
        commitSha: changeCommitSha,
        type: 'check_run' as const,
        context: 'ci',
        integrationId: 9001,
        githubObjectId: 8001,
        attempt: 1,
        status: 'completed' as const,
        conclusion: 'success' as const,
        detailsUrl: 'https://github.example/octocat/shipgate/actions/runs/8001',
        startedAt: new Date('2026-08-03T19:20:00.000Z'),
        completedAt: new Date('2026-08-03T19:21:00.000Z'),
        observedAt,
      },
    ],
    issues: [
      {
        id: 'sync-issue-unmanaged',
        severity: 'warning' as const,
        code: 'unmanaged_change',
        scope: 'commit' as const,
        subjectId: sourceSha,
        message: 'Source delta contains an unmanaged commit',
        details: {
          commitSha: sourceSha,
        },
      },
    ],
  }
}

async function seedRepositoryAccess(database: DatabaseClient): Promise<void> {
  await database.kysely
    .insertInto('github_installations')
    .values({
      installation_id: String(installationId),
      owner_id: String(ownerId),
      owner_type: 'User',
      owner_login: 'octocat',
      owner_avatar_url: null,
      repository_selection: 'selected',
      suspended_at: null,
      permission_state: 'current',
      lifecycle_state: 'active',
      deletion_requested_at: null,
      deleted_at: null,
      last_successful_confirmation_at: observedAt,
      last_reconciled_at: observedAt,
      updated_at: observedAt,
    })
    .execute()

  await database.kysely
    .insertInto('github_installation_repositories')
    .values({
      installation_id: String(installationId),
      repository_id: String(repositoryId),
      owner_id: String(ownerId),
      owner_login: 'octocat',
      name: 'shipgate',
      full_name: 'octocat/shipgate',
      private: true,
      archived: false,
      disabled: false,
      default_branch: 'main',
      visibility: 'private',
      last_successful_confirmation_at: observedAt,
      last_reconciled_at: observedAt,
      updated_at: observedAt,
    })
    .execute()
}

async function countRows(
  database: DatabaseClient,
  table:
    | 'repository_branches'
    | 'repository_commits'
    | 'changes'
    | 'change_commits'
    | 'required_checks'
    | 'commit_check_results'
    | 'repository_sync_runs'
    | 'repository_sync_issues',
): Promise<number> {
  const result = await sqlCount(database, table)
  return result
}

async function sqlCount(database: DatabaseClient, table: Parameters<typeof countRows>[1]) {
  switch (table) {
    case 'repository_branches':
      return Number(
        (
          await database.kysely
            .selectFrom('repository_branches')
            .select(({ fn }) => fn.countAll().as('count'))
            .executeTakeFirstOrThrow()
        ).count,
      )
    case 'repository_commits':
      return Number(
        (
          await database.kysely
            .selectFrom('repository_commits')
            .select(({ fn }) => fn.countAll().as('count'))
            .executeTakeFirstOrThrow()
        ).count,
      )
    case 'changes':
      return Number(
        (
          await database.kysely
            .selectFrom('changes')
            .select(({ fn }) => fn.countAll().as('count'))
            .executeTakeFirstOrThrow()
        ).count,
      )
    case 'change_commits':
      return Number(
        (
          await database.kysely
            .selectFrom('change_commits')
            .select(({ fn }) => fn.countAll().as('count'))
            .executeTakeFirstOrThrow()
        ).count,
      )
    case 'required_checks':
      return Number(
        (
          await database.kysely
            .selectFrom('required_checks')
            .select(({ fn }) => fn.countAll().as('count'))
            .executeTakeFirstOrThrow()
        ).count,
      )
    case 'commit_check_results':
      return Number(
        (
          await database.kysely
            .selectFrom('commit_check_results')
            .select(({ fn }) => fn.countAll().as('count'))
            .executeTakeFirstOrThrow()
        ).count,
      )
    case 'repository_sync_runs':
      return Number(
        (
          await database.kysely
            .selectFrom('repository_sync_runs')
            .select(({ fn }) => fn.countAll().as('count'))
            .executeTakeFirstOrThrow()
        ).count,
      )
    case 'repository_sync_issues':
      return Number(
        (
          await database.kysely
            .selectFrom('repository_sync_issues')
            .select(({ fn }) => fn.countAll().as('count'))
            .executeTakeFirstOrThrow()
        ).count,
      )
  }
}
