import {
  AdvisoryLockTimeoutError,
  checkDatabaseReadiness,
  createDatabase,
  type DatabaseClient,
  type DatabaseOperationError,
  getMigrationStatus,
  migrateToLatest,
  rollbackLastMigration,
  withRepositoryAdvisoryLock,
  withTransaction,
} from '@shipgate/database'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const expectedMigrationNames = [
  '20260730_000001_create_system_metadata',
  '20260730_000002_create_job_infrastructure',
  '20260730_000003_drop_system_metadata',
  '20260731_000004_create_github_auth_infrastructure',
  '20260801_000005_create_github_sessions',
  '20260801_000006_create_github_installation_access',
  '20260802_000007_create_github_webhook_deliveries',
  '20260802_000008_create_github_lifecycle_state',
  '20260803_000009_create_github_connection_read_model',
  '20260803_000010_create_project_repository_projection',
] as const

describe.sequential('PostgreSQL infrastructure', () => {
  let testDatabase: PostgresTestDatabase
  let database: DatabaseClient

  const poolErrors: DatabaseOperationError[] = []

  beforeAll(async () => {
    testDatabase = await startPostgresTestDatabase()

    database = createDatabase({
      connectionString: testDatabase.connectionString,
      applicationName: 'shipgate-database-test',

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

      onPoolError: (error) => {
        poolErrors.push(error)
      },
    })
  }, 60_000)

  afterAll(async () => {
    await database.destroy()
    await testDatabase.stop()
  })

  it('supports readiness, migrations, transactions and advisory locks', async () => {
    const initialStatus = await getMigrationStatus(database.kysely)

    expect(
      initialStatus.map((migration) => ({
        name: migration.name,
        status: migration.status,
      })),
    ).toEqual(
      expectedMigrationNames.map((name) => ({
        name,
        status: 'pending',
      })),
    )

    const migrationResults = await migrateToLatest(database.kysely)

    expect(migrationResults).toEqual(
      expectedMigrationNames.map((migrationName) =>
        expect.objectContaining({
          migrationName,
          direction: 'Up',
          status: 'Success',
        }),
      ),
    )

    const readiness = await checkDatabaseReadiness(database.kysely, 2_000)

    expect(readiness.ready).toBe(true)

    const rollbackMarker = new Error('rollback transaction')

    await expect(
      withTransaction(
        database.kysely,
        async (transaction) => {
          await transaction
            .insertInto('shipgate_worker_heartbeat')
            .values({
              worker_id: 'transaction-rollback-test',
              hostname: 'transaction-test',
              pid: 1,
              app_version: 'test',
              started_at: new Date(),
              heartbeat_at: new Date(),
            })
            .execute()

          throw rollbackMarker
        },
        {
          operation: 'test.rollback',
          isolationLevel: 'read committed',
        },
      ),
    ).rejects.toBe(rollbackMarker)

    const rolledBackRow = await database.kysely
      .selectFrom('shipgate_worker_heartbeat')
      .select('worker_id')
      .where('worker_id', '=', 'transaction-rollback-test')
      .executeTakeFirst()

    expect(rolledBackRow).toBeUndefined()

    let releaseFirstLock: (() => void) | undefined
    let notifyFirstLockAcquired: (() => void) | undefined

    const firstLockAcquired = new Promise<void>((resolve) => {
      notifyFirstLockAcquired = resolve
    })

    const holdFirstLock = new Promise<void>((resolve) => {
      releaseFirstLock = resolve
    })

    const firstLock = withRepositoryAdvisoryLock(database.kysely, 'test-repository', async () => {
      notifyFirstLockAcquired?.()
      await holdFirstLock
    })

    await firstLockAcquired

    try {
      await expect(
        withRepositoryAdvisoryLock(database.kysely, 'test-repository', async () => undefined, {
          timeoutMs: 200,
          retryIntervalMs: 25,
        }),
      ).rejects.toBeInstanceOf(AdvisoryLockTimeoutError)
    } finally {
      releaseFirstLock?.()
      await firstLock
    }

    const rollbackResults: Array<Awaited<ReturnType<typeof rollbackLastMigration>>[number]> = []

    for (let index = 0; index < expectedMigrationNames.length; index += 1) {
      rollbackResults.push(...(await rollbackLastMigration(database.kysely)))
    }

    expect(rollbackResults).toEqual(
      [...expectedMigrationNames].reverse().map((migrationName) =>
        expect.objectContaining({
          migrationName,
          direction: 'Down',
          status: 'Success',
        }),
      ),
    )

    const rolledBackStatus = await getMigrationStatus(database.kysely)

    expect(rolledBackStatus.every((migration) => migration.status === 'pending')).toBe(true)

    const firstRun = await migrateToLatest(database.kysely)

    expect(firstRun).toHaveLength(expectedMigrationNames.length)

    const secondRun = await migrateToLatest(database.kysely)

    expect(secondRun).toEqual([])

    expect(poolErrors).toEqual([])
  }, 60_000)
})
