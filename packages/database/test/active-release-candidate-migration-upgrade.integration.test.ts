import { promises as fileSystem } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createDatabase,
  type DatabaseClient,
  type DatabaseSchema,
  rollbackLastMigration,
} from '@shipgate/database'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { sql, type Transaction } from 'kysely'
import { FileMigrationProvider, Migrator } from 'kysely/migration'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const migrationFolder = fileURLToPath(new URL('../src/migrations/', import.meta.url))
const previousMigrationName = '20260814_000018_create_dependency_import_issues'
const activeCandidateMigrationName = '20260815_000019_create_active_release_candidate'

describe.sequential('active release-candidate migration upgrade path', () => {
  let postgres: PostgresTestDatabase
  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    database = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: 'shipgate-active-candidate-upgrade-test',
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
  }, 60_000)

  afterAll(async () => {
    await database.destroy()
    await postgres.stop()
  })

  it('backfills an existing active draft, preserves rollback compatibility and cascades operational history', async () => {
    const previous = await createTestMigrator(database).migrateTo(previousMigrationName)

    expect(previous.error).toBeUndefined()
    expect(previous.results?.at(-1)).toMatchObject({
      migrationName: previousMigrationName,
      direction: 'Up',
      status: 'Success',
    })

    const projectId = 'active-candidate-upgrade-project'
    const repositoryId = '92019'
    const candidateId = 'active-candidate-upgrade-candidate'
    const evaluationId = 'active-candidate-upgrade-evaluation'
    const sourceSha = 'a'.repeat(40)
    const productionSha = 'b'.repeat(40)
    const fingerprint = 'c'.repeat(64)
    const now = new Date('2026-08-15T00:00:00.000Z')

    await database.kysely.transaction().execute(async (transaction) => {
      await setRepositoryTransactionContext(transaction, repositoryId)
      await insertProject(transaction, {
        projectId,
        repositoryId,
        sourceSha,
        productionSha,
        now,
      })
      await transaction
        .insertInto('release_candidates')
        .values({
          id: candidateId,
          project_id: projectId,
          repository_id: repositoryId,
          sequence: 1,
          state: 'revision_active',
          version: 1,
          created_by_github_user_id: '99',
          note: null,
          latest_evaluation_version: null,
          closed_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute()
      await transaction
        .insertInto('release_candidate_evaluations')
        .values({
          id: evaluationId,
          candidate_id: candidateId,
          project_id: projectId,
          repository_id: repositoryId,
          evaluation_version: 1,
          candidate_version: 1,
          configuration_version: 1,
          source_sha: sourceSha,
          production_sha: productionSha,
          projection_fingerprint: fingerprint,
          required_check_policy_version: 0,
          result: 'ready',
          evaluation_fingerprint: fingerprint,
          summary: JSON.stringify({ status: 'ready' }),
          blockers: '[]',
          evaluated_at: now,
        })
        .execute()
      await transaction
        .updateTable('release_candidates')
        .set({ latest_evaluation_version: 1 })
        .where('id', '=', candidateId)
        .executeTakeFirstOrThrow()
    })

    const migrated = await createTestMigrator(database).migrateTo(activeCandidateMigrationName)

    expect(migrated.error).toBeUndefined()
    expect(migrated.results?.at(-1)).toMatchObject({
      migrationName: activeCandidateMigrationName,
      direction: 'Up',
      status: 'Success',
    })
    await expect(
      database.kysely
        .selectFrom('release_candidates')
        .select([
          'id',
          'state',
          'created_by_github_user_id',
          'evaluation_status',
          'latest_evaluation_version',
        ])
        .where('id', '=', candidateId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      id: candidateId,
      state: 'open',
      created_by_github_user_id: '99',
      evaluation_status: 'ready',
      latest_evaluation_version: 1,
    })
    await expect(
      database.kysely
        .selectFrom('projects')
        .select(['release_state_version', 'projection_version'])
        .where('id', '=', projectId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ release_state_version: 0, projection_version: 0 })

    const cascadeProjectId = 'active-candidate-cascade-project'
    const cascadeRepositoryId = '92020'
    const cascadeCandidateId = 'active-candidate-cascade-candidate'
    const cascadeRequestId = '92020000-0000-4000-8000-000000000001'
    const cascadeEvaluationId = 'active-candidate-cascade-evaluation'

    await database.kysely.transaction().execute(async (transaction) => {
      await setRepositoryTransactionContext(transaction, cascadeRepositoryId)
      await insertProject(transaction, {
        projectId: cascadeProjectId,
        repositoryId: cascadeRepositoryId,
        sourceSha,
        productionSha,
        now,
      })
      await transaction
        .insertInto('release_candidates')
        .values({
          id: cascadeCandidateId,
          project_id: cascadeProjectId,
          repository_id: cascadeRepositoryId,
          sequence: 1,
          state: 'open',
          version: 1,
          created_by_github_user_id: null,
          note: null,
          latest_evaluation_version: null,
          evaluation_status: 'ready',
          closed_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute()
      await transaction
        .insertInto('release_candidate_evaluation_requests')
        .values({
          id: cascadeRequestId,
          project_id: cascadeProjectId,
          repository_id: cascadeRepositoryId,
          candidate_id: cascadeCandidateId,
          status: 'succeeded',
          project_state_version: 0,
          projection_version: 0,
          candidate_version: 1,
          configuration_version: 1,
          required_check_policy_version: 0,
          source_sha: sourceSha,
          production_sha: productionSha,
          reasons: JSON.stringify(['first_projection']),
          coalesced_count: 0,
          attempt_count: 1,
          last_error_code: null,
          last_error_message: null,
          requested_at: now,
          claimed_at: now,
          completed_at: now,
          updated_at: now,
        })
        .execute()
      await transaction
        .insertInto('release_candidate_evaluations')
        .values({
          id: cascadeEvaluationId,
          candidate_id: cascadeCandidateId,
          project_id: cascadeProjectId,
          repository_id: cascadeRepositoryId,
          evaluation_version: 1,
          candidate_version: 1,
          request_id: cascadeRequestId,
          project_state_version: 0,
          projection_version: 0,
          configuration_version: 1,
          source_sha: sourceSha,
          production_sha: productionSha,
          projection_fingerprint: fingerprint,
          required_check_policy_version: 0,
          result: 'ready',
          evaluation_fingerprint: fingerprint,
          summary: JSON.stringify({ status: 'ready' }),
          blockers: '[]',
          evaluated_at: now,
        })
        .execute()
      await transaction
        .updateTable('release_candidates')
        .set({ latest_evaluation_version: 1 })
        .where('id', '=', cascadeCandidateId)
        .executeTakeFirstOrThrow()
      await transaction.deleteFrom('projects').where('id', '=', cascadeProjectId).execute()
    })

    await expect(
      database.kysely
        .selectFrom('release_candidate_evaluation_requests')
        .select('id')
        .where('id', '=', cascadeRequestId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined()
    await expect(
      database.kysely
        .selectFrom('release_candidate_evaluations')
        .select('id')
        .where('id', '=', cascadeEvaluationId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined()

    const rollback = await rollbackLastMigration(database.kysely)

    expect(rollback).toEqual([
      expect.objectContaining({
        migrationName: activeCandidateMigrationName,
        direction: 'Down',
        status: 'Success',
      }),
    ])
    await expect(
      database.kysely
        .selectFrom('release_candidates')
        .select(['id', 'state', 'created_by_github_user_id', 'latest_evaluation_version'])
        .where('id', '=', candidateId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      id: candidateId,
      state: 'open',
      created_by_github_user_id: '99',
      latest_evaluation_version: 1,
    })
  })
})

async function setRepositoryTransactionContext(
  transaction: Transaction<DatabaseSchema>,
  repositoryId: string,
): Promise<void> {
  await sql`select set_config('shipgate.repository_id', ${repositoryId}, true)`.execute(transaction)
  await sql`select set_config('shipgate.repository_lock', 'held', true)`.execute(transaction)
}

async function insertProject(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly projectId: string
    readonly repositoryId: string
    readonly sourceSha: string
    readonly productionSha: string
    readonly now: Date
  },
): Promise<void> {
  await transaction
    .insertInto('projects')
    .values({
      id: input.projectId,
      installation_id: String(Number(input.repositoryId) - 10_000),
      repository_id: input.repositoryId,
      owner_id: '99',
      owner_login: 'octocat',
      repository_name: `shipgate-${input.projectId}`,
      repository_full_name: `octocat/shipgate-${input.projectId}`,
      default_branch: 'main',
      source_branch: 'develop',
      production_branch: 'main',
      status: 'active',
      source_sha: input.sourceSha,
      production_sha: input.productionSha,
      last_successful_sync_at: input.now,
      merge_base_sha: input.productionSha,
      configuration_version: 1,
      required_check_policy_version: 0,
      required_check_overrides: '[]',
      qa_reset_epoch: 0,
      deletion_requested_at: null,
      deleted_at: null,
      updated_at: input.now,
    })
    .execute()
}

function createTestMigrator(database: DatabaseClient): Migrator {
  return new Migrator({
    db: database.kysely,
    provider: new FileMigrationProvider({
      fs: fileSystem,
      path,
      migrationFolder,
    }),
    migrationTableName: 'shipgate_migration',
    migrationLockTableName: 'shipgate_migration_lock',
    allowUnorderedMigrations: false,
  })
}
