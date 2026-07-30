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
    ).toEqual([
      {
        name: '20260730_000001_create_system_metadata',

        status: 'pending',
      },
      {
        name: '20260730_000002_create_job_infrastructure',

        status: 'pending',
      },
    ])

    const migrationResults = await migrateToLatest(database.kysely)

    expect(migrationResults).toEqual([
      expect.objectContaining({
        migrationName: '20260730_000001_create_system_metadata',
        direction: 'Up',
        status: 'Success',
      }),
    ])

    const readiness = await checkDatabaseReadiness(database.kysely, 2_000)

    expect(readiness.ready).toBe(true)

    const metadata = await database.kysely
      .selectFrom('shipgate_system_metadata')
      .selectAll()
      .where('key', '=', 'migration_infrastructure')
      .executeTakeFirstOrThrow()

    expect(metadata.value).toEqual({
      status: 'ready',
    })

    const rollbackMarker = new Error('rollback transaction')

    await expect(
      withTransaction(
        database.kysely,
        async (transaction) => {
          await transaction
            .insertInto('shipgate_system_metadata')
            .values({
              key: 'transaction_rollback_test',
              value: {
                inserted: true,
              },
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
      .selectFrom('shipgate_system_metadata')
      .select('key')
      .where('key', '=', 'transaction_rollback_test')
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

    await expect(
      withRepositoryAdvisoryLock(database.kysely, 'test-repository', async () => undefined, {
        timeoutMs: 200,
        retryIntervalMs: 25,
      }),
    ).rejects.toBeInstanceOf(AdvisoryLockTimeoutError)

    releaseFirstLock?.()
    await firstLock

    const firstRollback = await rollbackLastMigration(database.kysely)

    const secondRollback = await rollbackLastMigration(database.kysely)

    expect([...firstRollback, ...secondRollback]).toHaveLength(2)

    const rolledBackStatus = await getMigrationStatus(database.kysely)

    expect(rolledBackStatus.every((migration) => migration.status === 'pending')).toBe(true)

    await migrateToLatest(database.kysely)

    expect(poolErrors).toEqual([])
  }, 30_000)
})
