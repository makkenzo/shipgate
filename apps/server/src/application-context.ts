import {
  type GitHubSecrets,
  loadGitHubSecrets,
  loadRuntimeConfig,
  loadSecrets,
  type RuntimeConfig,
} from '@shipgate/config'
import { createDatabase, type DatabaseClient } from '@shipgate/database'
import type { Logger } from 'pino'

import { createCorrelationId, withCorrelationId } from './correlation-id.js'
import { createLogger, type ProcessKind } from './logger.js'
import { createShutdownManager, type ShutdownManager } from './shutdown.js'

export interface ApplicationContext {
  readonly processKind: ProcessKind
  readonly startedAt: Date
  readonly runtimeConfig: RuntimeConfig
  readonly logger: Logger
  readonly database: DatabaseClient
  readonly githubSecrets: GitHubSecrets
  readonly shutdown: ShutdownManager

  createCorrelationId(): string

  loggerFor(correlationId: string): Logger
}

export interface CreateApplicationContextOptions {
  readonly processKind: ProcessKind
  readonly environment?: NodeJS.ProcessEnv
}

export function createApplicationContext(
  options: CreateApplicationContextOptions,
): ApplicationContext {
  const environment = options.environment ?? process.env

  const runtimeConfig = loadRuntimeConfig(environment)
  const secrets = loadSecrets(environment)
  const githubSecrets = loadGitHubSecrets(environment)

  const logger = createLogger({
    processKind: options.processKind,
    runtimeConfig,
  })

  const shutdown = createShutdownManager({
    logger,
    timeoutMs: runtimeConfig.shutdownTimeoutMs,
  })

  const database = createDatabase({
    connectionString: secrets.databaseUrl,
    applicationName: `shipgate-${options.processKind}`,

    ssl: {
      mode: runtimeConfig.database.sslMode,
      ...(secrets.databaseSslCa
        ? {
            ca: secrets.databaseSslCa,
          }
        : {}),
    },

    pool: {
      min: runtimeConfig.database.poolMin,
      max: runtimeConfig.database.poolMax,
      idleTimeoutMs: runtimeConfig.database.idleTimeoutMs,
      connectionTimeoutMs: runtimeConfig.database.connectionTimeoutMs,
      maxLifetimeSeconds: runtimeConfig.database.maxLifetimeSeconds,
    },

    onPoolError: (error) => {
      logger.error(
        {
          event: 'database.pool.error',
          err: error,
          database: {
            kind: error.kind,
            retryable: error.retryable,
            sqlState: error.sqlState,
          },
        },
        'Unexpected PostgreSQL pool error',
      )
    },
  })

  /*
   * Database регистрируется раньше HTTP/worker.
   * Shutdown hooks исполняются в обратном порядке:
   * сначала HTTP/worker, затем pool.
   */
  shutdown.addHook('database', async () => {
    await database.destroy()
  })

  return {
    processKind: options.processKind,
    startedAt: new Date(),
    runtimeConfig,
    logger,
    database,
    githubSecrets,
    shutdown,
    createCorrelationId,

    loggerFor: (correlationId) => withCorrelationId(logger, correlationId),
  }
}
