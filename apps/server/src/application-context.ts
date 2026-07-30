import { loadRuntimeConfig, loadSecrets, type RuntimeConfig, type Secrets } from '@shipgate/config'
import type { Logger } from 'pino'

import { createCorrelationId, withCorrelationId } from './correlation-id.js'
import { createLogger, type ProcessKind } from './logger.js'
import { createShutdownManager, type ShutdownManager } from './shutdown.js'

export interface ApplicationContext {
  readonly processKind: ProcessKind
  readonly startedAt: Date
  readonly runtimeConfig: RuntimeConfig
  readonly secrets: Secrets
  readonly logger: Logger
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

  const logger = createLogger({
    processKind: options.processKind,
    runtimeConfig,
  })

  const shutdown = createShutdownManager({
    logger,
    timeoutMs: runtimeConfig.shutdownTimeoutMs,
  })

  return {
    processKind: options.processKind,
    startedAt: new Date(),
    runtimeConfig,
    secrets,
    logger,
    shutdown,
    createCorrelationId,

    loggerFor: (correlationId) => withCorrelationId(logger, correlationId),
  }
}
