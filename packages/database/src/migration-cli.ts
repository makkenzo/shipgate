import { loadRuntimeConfig, loadSecrets } from '@shipgate/config'

import { createDatabase } from './database.js'
import { DatabaseOperationError } from './errors.js'
import {
  getMigrationStatus,
  migrateToLatest,
  MigrationExecutionError,
  rollbackLastMigration,
} from './migrations.js'

type MigrationCommand = 'up' | 'down' | 'status'

const command = parseCommand(process.argv[2])

try {
  const runtimeConfig = loadRuntimeConfig()
  const secrets = loadSecrets()

  const database = createDatabase({
    connectionString: secrets.databaseUrl,
    applicationName: 'shipgate-migrator',

    ssl: {
      mode: runtimeConfig.database.sslMode,
      ...(secrets.databaseSslCa
        ? {
            ca: secrets.databaseSslCa,
          }
        : {}),
    },

    pool: {
      min: 0,
      max: Math.min(runtimeConfig.database.poolMax, 2),
      idleTimeoutMs: runtimeConfig.database.idleTimeoutMs,
      connectionTimeoutMs: runtimeConfig.database.connectionTimeoutMs,
      maxLifetimeSeconds: runtimeConfig.database.maxLifetimeSeconds,
    },

    allowExitOnIdle: true,

    onPoolError: (error) => {
      writeError({
        event: 'database.pool.error',
        error: serializeError(error),
      })
    },
  })

  try {
    switch (command) {
      case 'up': {
        const results = await migrateToLatest(database.kysely)

        writeOutput({
          event: 'database.migrations.completed',
          direction: 'up',
          results,
        })

        break
      }

      case 'down': {
        const results = await rollbackLastMigration(database.kysely)

        writeOutput({
          event: 'database.migrations.completed',
          direction: 'down',
          results,
        })

        break
      }

      case 'status': {
        const migrations = await getMigrationStatus(database.kysely)

        writeOutput({
          event: 'database.migrations.status',
          migrations,
        })

        break
      }
    }
  } finally {
    await database.destroy()
  }
} catch (error) {
  process.exitCode = 1

  writeError({
    event: 'database.migrations.fatal',
    command,
    error: serializeError(error),
  })
}

function parseCommand(value: string | undefined): MigrationCommand {
  if (value === 'up' || value === 'down' || value === 'status') {
    return value
  }

  throw new Error('Usage: migration-cli.js <up|down|status>')
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof DatabaseOperationError) {
    return {
      name: error.name,
      message: error.message,
      operation: error.operation,
      kind: error.kind,
      retryable: error.retryable,
      driverCode: error.driverCode,
      sqlState: error.sqlState,
      severity: error.severity,
      table: error.table,
      column: error.column,
      constraint: error.constraint,
    }
  }

  if (error instanceof MigrationExecutionError) {
    return {
      name: error.name,
      message: error.message,
      results: error.results,
    }
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    name: 'UnknownError',
    message: String(error),
  }
}

function writeOutput(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function writeError(value: unknown): void {
  process.stderr.write(`${JSON.stringify(value)}\n`)
}
