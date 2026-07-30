import { promises as fileSystem } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import type { Kysely } from 'kysely'
import { FileMigrationProvider, Migrator, type MigrationResult } from 'kysely/migration'

import type { DatabaseSchema } from './types.js'

const migrationFolder = fileURLToPath(new URL('./migrations/', import.meta.url))

export interface MigrationStatus {
  readonly name: string
  readonly status: 'executed' | 'pending'
  readonly executedAt: string | undefined
}

export class MigrationExecutionError extends Error {
  readonly results: readonly MigrationResult[]

  constructor(operation: string, cause: unknown, results: readonly MigrationResult[]) {
    super(`Database migration operation "${operation}" failed`, {
      cause,
    })

    this.name = 'MigrationExecutionError'
    this.results = results
  }
}

export async function migrateToLatest(
  database: Kysely<DatabaseSchema>,
): Promise<readonly MigrationResult[]> {
  const result = await createMigrator(database).migrateToLatest()

  return unwrapMigrationResult('up', result)
}

export async function rollbackLastMigration(
  database: Kysely<DatabaseSchema>,
): Promise<readonly MigrationResult[]> {
  const result = await createMigrator(database).migrateDown()

  return unwrapMigrationResult('down', result)
}

export async function getMigrationStatus(
  database: Kysely<DatabaseSchema>,
): Promise<readonly MigrationStatus[]> {
  const migrations = await createMigrator(database).getMigrations()

  return migrations.map((migration) => ({
    name: migration.name,
    status: migration.executedAt ? 'executed' : 'pending',
    executedAt: migration.executedAt?.toISOString(),
  }))
}

function createMigrator(database: Kysely<DatabaseSchema>): Migrator {
  return new Migrator({
    db: database,

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

function unwrapMigrationResult(
  operation: string,
  result: {
    readonly error?: unknown
    readonly results?: readonly MigrationResult[]
  },
): readonly MigrationResult[] {
  const results = result.results ?? []

  if (result.error) {
    throw new MigrationExecutionError(operation, result.error, results)
  }

  return results
}
