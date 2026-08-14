import { promises as fileSystem } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDatabase, type DatabaseClient, migrateToLatest } from '@shipgate/database'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { sql } from 'kysely'
import { FileMigrationProvider, Migrator } from 'kysely/migration'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const migrationFolder = fileURLToPath(new URL('../src/migrations/', import.meta.url))
const legacyMigrationName = '20260805_000015_create_incremental_repository_sync'

describe.sequential('release-planning migration upgrade path', () => {
  let postgres: PostgresTestDatabase
  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    database = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: 'shipgate-release-planning-upgrade-test',
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

  it('backfills existing audit rows and restores both write guards', async () => {
    const legacyResult = await createTestMigrator(database).migrateTo(legacyMigrationName)

    expect(legacyResult.error).toBeUndefined()
    expect(legacyResult.results?.at(-1)).toMatchObject({
      migrationName: legacyMigrationName,
      direction: 'Up',
      status: 'Success',
    })

    const projectId = 'release-planning-upgrade-project'
    const repositoryId = '91016'
    const auditEventId = 'release-planning-upgrade-audit-event'
    const sourceSha = 'a'.repeat(40)
    const productionSha = 'b'.repeat(40)
    const occurredAt = new Date('2026-08-11T00:00:00.000Z')

    await database.kysely.transaction().execute(async (transaction) => {
      await sql`select set_config('shipgate.repository_id', ${repositoryId}, true)`.execute(
        transaction,
      )
      await sql`select set_config('shipgate.repository_lock', 'held', true)`.execute(transaction)

      await sql`
        insert into projects (
          id,
          installation_id,
          repository_id,
          owner_id,
          owner_login,
          repository_name,
          repository_full_name,
          default_branch,
          source_branch,
          production_branch,
          status,
          source_sha,
          production_sha,
          last_successful_sync_at,
          merge_base_sha,
          configuration_version,
          required_check_policy_version,
          required_check_overrides,
          deletion_requested_at,
          deleted_at,
          updated_at
        ) values (
          ${projectId},
          '81016',
          ${repositoryId},
          '99',
          'octocat',
          'shipgate-upgrade',
          'octocat/shipgate-upgrade',
          'main',
          'develop',
          'main',
          'active',
          ${sourceSha},
          ${productionSha},
          ${occurredAt},
          ${productionSha},
          1,
          0,
          '[]'::jsonb,
          null,
          null,
          ${occurredAt}
        )
      `.execute(transaction)

      await sql`
        insert into project_audit_events (
          id,
          project_id,
          repository_id,
          actor_github_user_id,
          event_type,
          source,
          configuration_version,
          payload,
          occurred_at
        ) values (
          ${auditEventId},
          ${projectId},
          ${repositoryId},
          '99',
          'project_created',
          'user',
          1,
          '{}'::jsonb,
          ${occurredAt}
        )
      `.execute(transaction)
    })

    await expect(migrateToLatest(database.kysely)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          migrationName: '20260811_000016_create_release_planning_persistence',
          direction: 'Up',
          status: 'Success',
        }),
      ]),
    )

    await expect(
      database.kysely
        .selectFrom('audit_events')
        .select(['id', 'entity_type', 'entity_id'])
        .where('id', '=', auditEventId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      id: auditEventId,
      entity_type: 'project',
      entity_id: projectId,
    })

    const triggerResult = await sql<{ readonly tgname: string; readonly tgenabled: string }>`
      select tgname, tgenabled
      from pg_trigger
      where tgrelid = 'audit_events'::regclass
        and tgname in (
          'audit_events_append_only',
          'audit_events_repository_projection_write_guard'
        )
      order by tgname
    `.execute(database.kysely)

    expect(triggerResult.rows).toEqual([
      { tgname: 'audit_events_append_only', tgenabled: 'O' },
      { tgname: 'audit_events_repository_projection_write_guard', tgenabled: 'O' },
    ])

    await expect(
      database.kysely
        .updateTable('audit_events')
        .set({ reason_code: 'must_not_update' })
        .where('id', '=', auditEventId)
        .execute(),
    ).rejects.toThrow(/append-only/)
  })
})

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
