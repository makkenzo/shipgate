import {
  createDatabase,
  type DatabaseClient,
  type DatabaseSchema,
  DatabaseOperationError,
  migrateToLatest,
  withRepositoryAdvisoryLock,
  withTransaction,
} from '@shipgate/database'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { sql, type Transaction } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const actorGitHubUserId = '99'
const projectId = 'release-planning-project'
const repositoryId = '91001'
const otherProjectId = 'release-planning-other-project'
const otherRepositoryId = '91002'
const sourceSha = 'a'.repeat(40)
const productionSha = 'b'.repeat(40)
const firstHeadSha = 'c'.repeat(40)
const secondHeadSha = 'd'.repeat(40)
const changedHeadSha = 'e'.repeat(40)
const historicalHeadSha = '7'.repeat(40)
const firstFingerprint = '1'.repeat(64)
const secondFingerprint = '2'.repeat(64)
const changedFingerprint = '3'.repeat(64)
const historicalFingerprint = '7'.repeat(64)
const projectionFingerprint = '4'.repeat(64)
const evaluationFingerprint = '5'.repeat(64)
const firstChangeId = 'release-planning-change-1'
const secondChangeId = 'release-planning-change-2'
const historicalChangeId = 'release-planning-change-history'
const otherChangeId = 'release-planning-other-change'
const candidateId = 'release-planning-candidate-1'

const now = new Date('2026-08-11T18:00:00.000Z')

describe.sequential('Release-planning persistence', () => {
  let postgres: PostgresTestDatabase
  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    database = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: 'shipgate-release-planning-persistence-test',
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

    await migrateToLatest(database.kysely)
    await seedProject(database, {
      projectId,
      repositoryId,
      changeIds: [firstChangeId, secondChangeId, historicalChangeId],
      headShas: [firstHeadSha, secondHeadSha, historicalHeadSha],
      fingerprints: [firstFingerprint, secondFingerprint, historicalFingerprint],
    })
    await seedProject(database, {
      projectId: otherProjectId,
      repositoryId: otherRepositoryId,
      changeIds: [otherChangeId],
      headShas: ['f'.repeat(40)],
      fingerprints: ['6'.repeat(64)],
    })
  }, 60_000)

  afterAll(async () => {
    await database.destroy()
    await postgres.stop()
  })

  it('keeps QA history immutable and only exposes an assessment for the current Change version', async () => {
    await withRepositoryWrite(database, repositoryId, async (transaction) => {
      await transaction
        .insertInto('change_qa_assessments')
        .values({
          id: 'qa-assessment-1',
          project_id: projectId,
          repository_id: repositoryId,
          change_id: firstChangeId,
          final_head_sha: firstHeadSha,
          commit_set_fingerprint: firstFingerprint,
          sequence: 1,
          status: 'passed',
          actor_github_user_id: actorGitHubUserId,
          comment: 'Validated against the first projected version.',
          previous_status: 'pending',
          correlation_id: 'test:qa:first',
          reason_code: 'qa_assessment_recorded',
          created_at: now,
        })
        .execute()
    })

    await expect(
      database.kysely
        .selectFrom('effective_change_qa_assessments')
        .select(['id', 'status', 'final_head_sha', 'commit_set_fingerprint'])
        .where('change_id', '=', firstChangeId)
        .executeTakeFirst(),
    ).resolves.toEqual({
      id: 'qa-assessment-1',
      status: 'passed',
      final_head_sha: firstHeadSha,
      commit_set_fingerprint: firstFingerprint,
    })

    await withRepositoryWrite(database, repositoryId, async (transaction) => {
      await transaction
        .updateTable('changes')
        .set({
          final_head_sha: changedHeadSha,
          merge_commit_sha: changedHeadSha,
          source_integration_sha: changedHeadSha,
          commit_set_fingerprint: changedFingerprint,
          observed_at: new Date(now.getTime() + 1_000),
          updated_at: new Date(now.getTime() + 1_000),
        })
        .where('id', '=', firstChangeId)
        .executeTakeFirstOrThrow()
    })

    await expect(
      database.kysely
        .selectFrom('effective_change_qa_assessments')
        .select('id')
        .where('change_id', '=', firstChangeId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined()

    const historyCount = await database.kysely
      .selectFrom('change_qa_assessments')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('change_id', '=', firstChangeId)
      .executeTakeFirstOrThrow()

    expect(Number(historyCount.count)).toBe(1)

    await withRepositoryWrite(database, repositoryId, async (transaction) => {
      await transaction
        .insertInto('change_qa_assessments')
        .values({
          id: 'qa-assessment-2',
          project_id: projectId,
          repository_id: repositoryId,
          change_id: firstChangeId,
          final_head_sha: changedHeadSha,
          commit_set_fingerprint: changedFingerprint,
          sequence: 2,
          status: 'pending',
          actor_github_user_id: null,
          comment: null,
          previous_status: 'passed',
          correlation_id: 'test:qa:reset',
          reason_code: 'qa_assessment_reset',
          created_at: new Date(now.getTime() + 2_000),
        })
        .execute()
    })

    await expect(
      database.kysely
        .selectFrom('effective_change_qa_assessments')
        .select(['id', 'status'])
        .where('change_id', '=', firstChangeId)
        .executeTakeFirst(),
    ).resolves.toEqual({ id: 'qa-assessment-2', status: 'pending' })

    await expectDatabaseFailure(
      withRepositoryWrite(database, repositoryId, async (transaction) => {
        await transaction
          .updateTable('change_qa_assessments')
          .set({ status: 'passed' })
          .where('id', '=', 'qa-assessment-2')
          .execute()
      }),
      /immutable/,
    )
  })

  it('keeps dependencies Project-scoped without coupling their lifetime to projection rows', async () => {
    await withRepositoryWrite(database, repositoryId, async (transaction) => {
      await transaction
        .insertInto('change_dependencies')
        .values({
          project_id: projectId,
          repository_id: repositoryId,
          dependent_change_id: secondChangeId,
          prerequisite_change_id: firstChangeId,
          source: 'user',
          actor_github_user_id: actorGitHubUserId,
          comment: 'The second change consumes the first change.',
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .execute()
    })

    await expect(
      database.kysely
        .selectFrom('change_dependencies')
        .select(['dependent_change_id', 'prerequisite_change_id'])
        .where('project_id', '=', projectId)
        .execute(),
    ).resolves.toEqual([
      {
        dependent_change_id: secondChangeId,
        prerequisite_change_id: firstChangeId,
      },
    ])

    await expectDatabaseFailure(
      withRepositoryWrite(database, repositoryId, async (transaction) => {
        await transaction
          .insertInto('change_dependencies')
          .values({
            project_id: projectId,
            repository_id: repositoryId,
            dependent_change_id: secondChangeId,
            prerequisite_change_id: otherChangeId,
            source: 'user',
            actor_github_user_id: actorGitHubUserId,
            comment: null,
            version: 2,
          })
          .execute()
      }),
      /does not belong to Project/,
    )

    await expectDatabaseFailure(
      withRepositoryWrite(database, repositoryId, async (transaction) => {
        await transaction
          .insertInto('change_dependencies')
          .values({
            project_id: projectId,
            repository_id: repositoryId,
            dependent_change_id: firstChangeId,
            prerequisite_change_id: secondChangeId,
            source: 'user',
            actor_github_user_id: actorGitHubUserId,
            comment: null,
            version: 2,
          })
          .execute()
      }),
      /cycle/,
    )
  })

  it('retains Shipgate-owned decisions after a Change disappears from the GitHub projection', async () => {
    await withRepositoryWrite(database, repositoryId, async (transaction) => {
      await transaction
        .insertInto('change_qa_assessments')
        .values({
          id: 'qa-assessment-historical',
          project_id: projectId,
          repository_id: repositoryId,
          change_id: historicalChangeId,
          final_head_sha: historicalHeadSha,
          commit_set_fingerprint: historicalFingerprint,
          sequence: 1,
          status: 'passed',
          actor_github_user_id: actorGitHubUserId,
          comment: null,
          previous_status: 'pending',
          correlation_id: 'test:qa:historical',
          reason_code: 'qa_assessment_recorded',
          created_at: now,
        })
        .execute()

      await transaction
        .insertInto('change_dependencies')
        .values({
          project_id: projectId,
          repository_id: repositoryId,
          dependent_change_id: historicalChangeId,
          prerequisite_change_id: firstChangeId,
          source: 'user',
          actor_github_user_id: actorGitHubUserId,
          comment: null,
          version: 2,
          created_at: now,
          updated_at: now,
        })
        .execute()

      await transaction.deleteFrom('changes').where('id', '=', historicalChangeId).execute()
    })

    await expect(
      database.kysely
        .selectFrom('change_qa_assessments')
        .select('id')
        .where('change_id', '=', historicalChangeId)
        .executeTakeFirst(),
    ).resolves.toEqual({ id: 'qa-assessment-historical' })

    await expect(
      database.kysely
        .selectFrom('effective_change_qa_assessments')
        .select('id')
        .where('change_id', '=', historicalChangeId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined()

    await expect(
      database.kysely
        .selectFrom('change_dependencies')
        .select('dependent_change_id')
        .where('dependent_change_id', '=', historicalChangeId)
        .executeTakeFirst(),
    ).resolves.toEqual({ dependent_change_id: historicalChangeId })
  })

  it('stores one active candidate, explicit exclusions and versioned evaluation summaries only', async () => {
    await withRepositoryWrite(database, repositoryId, async (transaction) => {
      await transaction
        .insertInto('release_candidates')
        .values({
          id: candidateId,
          project_id: projectId,
          repository_id: repositoryId,
          sequence: 1,
          state: 'open',
          version: 1,
          created_by_github_user_id: actorGitHubUserId,
          note: 'Next production release',
          latest_evaluation_version: null,
          closed_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute()

      await transaction
        .insertInto('candidate_exclusions')
        .values({
          candidate_id: candidateId,
          project_id: projectId,
          repository_id: repositoryId,
          change_id: secondChangeId,
          actor_github_user_id: actorGitHubUserId,
          reason: 'Hold for the next train.',
          candidate_version: 1,
          created_at: now,
          updated_at: now,
        })
        .execute()

      await transaction
        .insertInto('release_candidate_evaluations')
        .values({
          id: 'release-planning-evaluation-1',
          candidate_id: candidateId,
          project_id: projectId,
          repository_id: repositoryId,
          evaluation_version: 1,
          candidate_version: 1,
          configuration_version: 1,
          source_sha: sourceSha,
          production_sha: productionSha,
          projection_fingerprint: projectionFingerprint,
          required_check_policy_version: 0,
          result: 'blocked',
          evaluation_fingerprint: evaluationFingerprint,
          summary: JSON.stringify({ ready: 0, blocked: 1, excluded: 1 }),
          blockers: JSON.stringify([
            {
              code: 'qa_pending',
              scope: 'change',
              subjectId: firstChangeId,
            },
          ]),
          evaluated_at: now,
          created_at: now,
        })
        .execute()

      await transaction
        .updateTable('release_candidates')
        .set({ latest_evaluation_version: 1, updated_at: now })
        .where('id', '=', candidateId)
        .executeTakeFirstOrThrow()
    })

    await expect(
      withRepositoryWrite(database, repositoryId, async (transaction) => {
        await transaction
          .insertInto('release_candidates')
          .values({
            id: 'release-planning-candidate-conflict',
            project_id: projectId,
            repository_id: repositoryId,
            sequence: 2,
            state: 'open',
            version: 1,
            created_by_github_user_id: actorGitHubUserId,
            note: null,
            latest_evaluation_version: null,
            closed_at: null,
          })
          .execute()
      }),
    ).rejects.toThrow()

    await expect(
      database.kysely
        .selectFrom('release_candidates')
        .select(['id', 'latest_evaluation_version'])
        .where('project_id', '=', projectId)
        .execute(),
    ).resolves.toEqual([{ id: candidateId, latest_evaluation_version: 1 }])

    const columns = await sql<{ readonly column_name: string }>`
      select column_name
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'release_candidates'
      order by ordinal_position
    `.execute(database.kysely)

    const candidateColumns = columns.rows.map((row) => row.column_name)

    for (const copiedCompositionColumn of [
      'change_ids',
      'included_change_ids',
      'pull_request_ids',
      'composition',
    ]) {
      expect(candidateColumns).not.toContain(copiedCompositionColumn)
    }

    await expect(
      withRepositoryWrite(database, repositoryId, async (transaction) => {
        await transaction
          .updateTable('release_candidates')
          .set({ version: 2, updated_at: new Date(now.getTime() + 1_000) })
          .where('id', '=', candidateId)
          .executeTakeFirstOrThrow()
      }),
    ).rejects.toThrow()
  })

  it('uses one generic append-only audit table for Project and release-planning decisions', async () => {
    await withRepositoryWrite(database, repositoryId, async (transaction) => {
      await transaction
        .insertInto('audit_events')
        .values({
          id: 'release-planning-audit-1',
          project_id: projectId,
          repository_id: repositoryId,
          actor_github_user_id: actorGitHubUserId,
          event_type: 'release_candidate_created',
          source: 'user',
          configuration_version: 1,
          entity_type: 'release_candidate',
          entity_id: candidateId,
          correlation_id: 'test:candidate:create',
          reason_code: 'release_candidate_created',
          before_state: null,
          after_state: JSON.stringify({ state: 'open', version: 1 }),
          payload: JSON.stringify({ candidateId, sequence: 1 }),
          occurred_at: now,
          created_at: now,
        })
        .execute()
    })

    await expect(
      database.kysely
        .selectFrom('audit_events')
        .select(['entity_type', 'entity_id', 'event_type'])
        .where('id', '=', 'release-planning-audit-1')
        .executeTakeFirst(),
    ).resolves.toEqual({
      entity_type: 'release_candidate',
      entity_id: candidateId,
      event_type: 'release_candidate_created',
    })

    await expectDatabaseFailure(
      withRepositoryWrite(database, repositoryId, async (transaction) => {
        await transaction
          .updateTable('audit_events')
          .set({ reason_code: 'changed' })
          .where('id', '=', 'release-planning-audit-1')
          .execute()
      }),
      /append-only/,
    )
  })
})

async function expectDatabaseFailure(
  operation: Promise<unknown>,
  expectedCauseMessage: RegExp,
): Promise<void> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseOperationError)

    if (!(error instanceof DatabaseOperationError)) {
      return
    }

    expect(error.cause).toMatchObject({
      message: expect.stringMatching(expectedCauseMessage),
    })
    return
  }

  throw new Error('Expected database operation to fail')
}

async function seedProject(
  database: DatabaseClient,
  input: {
    readonly projectId: string
    readonly repositoryId: string
    readonly changeIds: readonly string[]
    readonly headShas: readonly string[]
    readonly fingerprints: readonly string[]
  },
): Promise<void> {
  if (
    input.changeIds.length !== input.headShas.length ||
    input.changeIds.length !== input.fingerprints.length
  ) {
    throw new Error('Release-planning fixture arrays must have the same length')
  }

  await withRepositoryWrite(database, input.repositoryId, async (transaction) => {
    await transaction
      .insertInto('projects')
      .values({
        id: input.projectId,
        installation_id: String(Number(input.repositoryId) + 10_000),
        repository_id: input.repositoryId,
        owner_id: actorGitHubUserId,
        owner_login: 'octocat',
        repository_name: input.projectId,
        repository_full_name: `octocat/${input.projectId}`,
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
        created_at: now,
        updated_at: now,
      })
      .execute()

    await transaction
      .insertInto('changes')
      .values(
        input.changeIds.map((changeId, index) => {
          const finalHeadSha = input.headShas[index]
          const commitSetFingerprint = input.fingerprints[index]

          if (!finalHeadSha || !commitSetFingerprint) {
            throw new Error(`Missing release-planning fixture data at index ${index}`)
          }

          return {
            id: changeId,
            project_id: input.projectId,
            repository_id: input.repositoryId,
            github_pull_request_id: String(Number(input.repositoryId) * 10 + index + 1),
            pull_request_number: index + 1,
            title: `Release-planning change ${index + 1}`,
            url: `https://github.example/octocat/${input.projectId}/pull/${index + 1}`,
            author_id: actorGitHubUserId,
            author_login: 'octocat',
            base_branch: 'develop',
            merged_at: new Date(now.getTime() + index),
            final_head_sha: finalHeadSha,
            merge_commit_sha: finalHeadSha,
            source_integration_sha: finalHeadSha,
            integration_first_parent_sha: productionSha,
            integration_second_parent_sha: null,
            merge_method: 'squash' as const,
            commit_set_fingerprint: commitSetFingerprint,
            synchronization_state: 'known' as const,
            production_presence: 'unreleased' as const,
            observed_at: now,
            created_at: now,
            updated_at: now,
          }
        }),
      )
      .execute()
  })
}

async function withRepositoryWrite<Result>(
  database: DatabaseClient,
  repositoryId: string,
  callback: (transaction: Transaction<DatabaseSchema>) => Promise<Result>,
): Promise<Result> {
  return withRepositoryAdvisoryLock(database.kysely, repositoryId, (connection) =>
    withTransaction(
      connection,
      async (transaction) => {
        await sql`
          select
            set_config('shipgate.repository_id', ${repositoryId}, true),
            set_config('shipgate.repository_lock', 'held', true)
        `.execute(transaction)

        return callback(transaction)
      },
      {
        operation: `test.release-planning:${repositoryId}`,
        isolationLevel: 'serializable',
        accessMode: 'read write',
      },
    ),
  )
}
