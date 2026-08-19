import { createDatabase, type DatabaseClient, migrateToLatest } from '@shipgate/database'
import type { GitHubAuthenticationService, UserGitHubClient } from '@shipgate/github'
import { migrateJobQueue } from '@shipgate/jobs'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  persistPreparedDependencyMutation,
  prepareSetDependencies,
  type SetDependencies,
} from '../src/projects/dependency-workflow.js'
import {
  createDependencyService,
  DependencySynchronizationError,
  importDependenciesFromPullRequestWebhook,
  listChangeDependencies,
  withRepositoryTransaction,
} from '../src/projects/index.js'

const actorGitHubUserId = 99
const sourceSha = 'a'.repeat(40)
const productionSha = 'b'.repeat(40)

interface DependencyFixture {
  readonly projectId: string
  readonly repositoryId: number
  readonly changeIds: readonly [string, string, string]
}

describe.sequential('Dependency workflow', () => {
  let postgres: PostgresTestDatabase
  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    database = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: 'shipgate-dependency-workflow-test',
      ssl: { mode: 'disable' },
      pool: {
        min: 0,
        max: 8,
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

  it('records one dependency, a chain A -> B -> C, and multiple direct dependencies', async () => {
    const fixture = await seedDependencyFixture(database, 1)
    const [changeA, changeB, changeC] = fixture.changeIds

    await setDependencies(database, fixture, changeB, [changeC], 'dependency:chain:b-c')
    const chain = await setDependencies(
      database,
      fixture,
      changeA,
      [changeB],
      'dependency:chain:a-b',
    )

    expect(chain.dependencies.map((dependency) => dependency.changeId)).toEqual([changeB])
    await expect(
      listChangeDependencies(database, fixture.projectId, changeB),
    ).resolves.toMatchObject([{ changeId: changeC, pullRequestNumber: 103 }])

    const multiple = await setDependencies(
      database,
      fixture,
      changeA,
      [changeC, changeB],
      'dependency:multiple',
    )

    expect(multiple.dependencies.map((dependency) => dependency.pullRequestNumber)).toEqual([
      102, 103,
    ])
    expect(multiple.dependencies.every((dependency) => dependency.source === 'user')).toBe(true)
  })

  it('rejects self-dependency and a cycle without changing the persisted DAG', async () => {
    const fixture = await seedDependencyFixture(database, 2)
    const [changeA, changeB, changeC] = fixture.changeIds

    await expect(
      setDependencies(database, fixture, changeA, [changeA], 'dependency:self'),
    ).rejects.toMatchObject({ code: 'dependency_self_reference' })

    await setDependencies(database, fixture, changeA, [changeB], 'dependency:cycle:a-b')
    await setDependencies(database, fixture, changeB, [changeC], 'dependency:cycle:b-c')

    await expect(
      setDependencies(database, fixture, changeC, [changeA], 'dependency:cycle:c-a'),
    ).rejects.toMatchObject({
      code: 'dependency_cycle',
      details: { cycle: [changeA, changeB, changeC, changeA] },
    })
    await expect(listChangeDependencies(database, fixture.projectId, changeC)).resolves.toEqual([])
  })

  it('imports a valid managed PR-body block and records an invalid block as an issue', async () => {
    const valid = await seedDependencyFixture(database, 3)
    const [validA, validB] = valid.changeIds

    await importManagedBody(database, valid, 101, [102], 'delivery-valid')
    await expect(listChangeDependencies(database, valid.projectId, validA)).resolves.toMatchObject([
      {
        changeId: validB,
        pullRequestNumber: 102,
        source: 'managed_pr_body',
        actorGitHubUserId: String(actorGitHubUserId),
      },
    ])

    const invalid = await seedDependencyFixture(database, 4)
    const [invalidA] = invalid.changeIds
    await importRawBody(
      database,
      invalid,
      101,
      [
        '<!-- shipgate:dependencies -->',
        'Shipgate-Depends-On: not-a-pr',
        '<!-- /shipgate:dependencies -->',
      ].join('\n'),
      'delivery-invalid',
    )

    await expect(listChangeDependencies(database, invalid.projectId, invalidA)).resolves.toEqual([])
    await expect(
      database.kysely
        .selectFrom('release_planning_issues')
        .select(['category', 'entity_id', 'code', 'source_reference'])
        .where('project_id', '=', invalid.projectId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      category: 'dependency_managed_block',
      entity_id: invalidA,
      code: 'invalid_pull_request_reference',
      source_reference: 'delivery-invalid',
    })
  })

  it('does not persist local dependencies when the GitHub PR-body mutation fails', async () => {
    const fixture = await seedDependencyFixture(database, 5)
    const [changeA, changeB] = fixture.changeIds
    const client = githubClientThatFailsMutation()
    const service = createDependencyService({
      database,
      githubAuth: {
        async getUserClient() {
          return client
        },
      } as unknown as GitHubAuthenticationService,
    })

    await expect(
      service.set({
        actorGitHubUserId,
        projectId: fixture.projectId,
        changeId: changeA,
        dependencyChangeIds: [changeB],
        correlationId: 'dependency:github-failure',
      }),
    ).rejects.toBeInstanceOf(DependencySynchronizationError)

    await expect(listChangeDependencies(database, fixture.projectId, changeA)).resolves.toEqual([])
    await expect(
      database.kysely
        .selectFrom('audit_events')
        .select('id')
        .where('project_id', '=', fixture.projectId)
        .where('event_type', '=', 'dependencies_changed')
        .execute(),
    ).resolves.toEqual([])
  })
})

async function setDependencies(
  database: DatabaseClient,
  fixture: DependencyFixture,
  changeId: string,
  dependencyChangeIds: readonly string[],
  correlationId: string,
) {
  const command: SetDependencies = {
    actorGitHubUserId,
    projectId: fixture.projectId,
    changeId,
    dependencyChangeIds,
    source: 'user',
    correlationId,
  }

  return withRepositoryTransaction(database, fixture.repositoryId, async (scope) => {
    const plan = await prepareSetDependencies(scope, command)
    return persistPreparedDependencyMutation(scope, command, plan)
  })
}

async function seedDependencyFixture(
  database: DatabaseClient,
  index: number,
): Promise<DependencyFixture> {
  const projectId = `dependency-project-${index}`
  const repositoryId = 94_000 + index
  const installationId = 93_000 + index
  const changeIds = [
    `dependency-change-${index}-a`,
    `dependency-change-${index}-b`,
    `dependency-change-${index}-c`,
  ] as const
  const now = new Date(`2026-08-14T1${index}:00:00.000Z`)

  await withRepositoryTransaction(database, repositoryId, async ({ transaction }) => {
    await transaction
      .insertInto('projects')
      .values({
        id: projectId,
        installation_id: String(installationId),
        repository_id: String(repositoryId),
        owner_id: String(actorGitHubUserId),
        owner_login: 'octocat',
        repository_name: `dependency-fixture-${index}`,
        repository_full_name: `octocat/dependency-fixture-${index}`,
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

    await transaction
      .insertInto('changes')
      .values(
        changeIds.map((changeId, changeIndex) => {
          const pullRequestNumber = 101 + changeIndex
          const sha = String(index + changeIndex + 1).repeat(40)
          return {
            id: changeId,
            project_id: projectId,
            repository_id: String(repositoryId),
            github_pull_request_id: String(60_000 + index * 10 + changeIndex),
            pull_request_number: pullRequestNumber,
            title: `Dependency change ${pullRequestNumber}`,
            url: `https://github.com/octocat/dependency-fixture-${index}/pull/${pullRequestNumber}`,
            author_id: String(actorGitHubUserId),
            author_login: 'octocat',
            base_branch: 'develop',
            merged_at: new Date(now.getTime() + changeIndex * 1_000),
            final_head_sha: sha,
            merge_commit_sha: sha,
            source_integration_sha: sha,
            integration_first_parent_sha: productionSha,
            integration_second_parent_sha: null,
            merge_method: 'squash' as const,
            commit_set_fingerprint: sha.repeat(2).slice(0, 64),
            synchronization_state: 'known' as const,
            production_presence: 'unreleased' as const,
            observed_at: now,
            updated_at: now,
          }
        }),
      )
      .execute()
  })

  return { projectId, repositoryId, changeIds }
}

async function importManagedBody(
  database: DatabaseClient,
  fixture: DependencyFixture,
  pullRequestNumber: number,
  dependencyPullRequestNumbers: readonly number[],
  deliveryId: string,
): Promise<void> {
  const references = dependencyPullRequestNumbers.map((number) => `#${number}`).join(', ')
  await importRawBody(
    database,
    fixture,
    pullRequestNumber,
    [
      '<!-- shipgate:dependencies -->',
      `Shipgate-Depends-On: ${references}`,
      '<!-- /shipgate:dependencies -->',
    ].join('\n'),
    deliveryId,
  )
}

async function importRawBody(
  database: DatabaseClient,
  fixture: DependencyFixture,
  pullRequestNumber: number,
  body: string,
  deliveryId: string,
): Promise<void> {
  await importDependenciesFromPullRequestWebhook(database, {
    event: 'pull_request',
    action: 'edited',
    repositoryId: String(fixture.repositoryId),
    deliveryId,
    correlationId: `github-webhook:${deliveryId}`,
    payload: {
      action: 'edited',
      number: pullRequestNumber,
      changes: { body: { from: null } },
      repository: { id: fixture.repositoryId },
      pull_request: { number: pullRequestNumber, body },
      sender: { id: actorGitHubUserId },
    },
  } as never)
}

function githubClientThatFailsMutation(): UserGitHubClient {
  return {
    authentication: { type: 'user', userId: actorGitHubUserId },
    async request<Data = unknown>(
      route: string,
    ): Promise<{
      readonly data: Data
      readonly status: number
      readonly headers: Readonly<Record<string, string>>
      readonly url: string
    }> {
      if (route === 'GET /repos/{owner}/{repo}') {
        return response({ permissions: { triage: true }, role_name: 'triage' } as Data)
      }

      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return response({ body: 'Existing PR body.' } as Data)
      }

      if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') {
        throw Object.assign(new Error('GitHub mutation failed'), { status: 502 })
      }

      throw new Error(`Unexpected GitHub route ${route}`)
    },
    async graphql<Data = unknown>(): Promise<Data> {
      return {} as Data
    },
  }
}

function response<Data>(data: Data) {
  return {
    data,
    status: 200,
    headers: {},
    url: 'https://api.github.test/dependency-fixture',
  }
}
