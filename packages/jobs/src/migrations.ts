import type { DatabaseClient } from '@shipgate/database'
import { runMigrations } from 'graphile-worker'
import { sql } from 'kysely'

export async function migrateJobQueue(database: DatabaseClient): Promise<void> {
  await runMigrations({
    pgPool: database.pool,
    noHandleSignals: true,
  })
}

export async function isJobQueueInstalled(database: DatabaseClient): Promise<boolean> {
  const result = await sql<{
    readonly installed: boolean
  }>`
    select
      to_regclass(
        'graphile_worker.jobs'
      ) is not null as installed
  `.execute(database.kysely)

  return result.rows[0]?.installed === true
}
