import { Kysely, PostgresDialect } from 'kysely'
import { Client, Pool, type PoolConfig } from 'pg'

import { normalizeDatabaseError } from './errors.js'
import type { CreateDatabaseOptions, DatabaseClient, DatabaseSchema } from './types.js'

export function createDatabase(options: CreateDatabaseOptions): DatabaseClient {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,

    min: options.pool.min,
    max: options.pool.max,
    idleTimeoutMillis: options.pool.idleTimeoutMs,
    connectionTimeoutMillis: options.pool.connectionTimeoutMs,
    maxLifetimeSeconds: options.pool.maxLifetimeSeconds,

    allowExitOnIdle: options.allowExitOnIdle ?? false,

    ssl: createSslConfig(options.ssl),
  })

  const handlePoolError = (error: Error, operation: string): void => {
    const normalizedError = normalizeDatabaseError(error, operation)

    try {
      options.onPoolError(normalizedError)
    } catch (handlerError) {
      process.emitWarning(`Database pool error handler failed: ${String(handlerError)}`)
    }
  }

  pool.on('error', (error) => {
    handlePoolError(error, 'pool.idle-client')
  })

  pool.on('connect', (client) => {
    client.on('error', (error) => {
      handlePoolError(error, 'pool.client')
    })
  })

  const kysely = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool,
      controlClient: Client,
    }),
  })

  let destroyPromise: Promise<void> | undefined

  return {
    kysely,
    pool,

    destroy() {
      destroyPromise ??= kysely.destroy()

      return destroyPromise
    },
  }
}

function createSslConfig(ssl: CreateDatabaseOptions['ssl']): PoolConfig['ssl'] {
  switch (ssl.mode) {
    case 'disable':
      return false

    case 'require':
      return {
        rejectUnauthorized: false,
      }

    case 'verify-full':
      return {
        rejectUnauthorized: true,
        ...(ssl.ca ? { ca: ssl.ca } : {}),
      }
  }
}
