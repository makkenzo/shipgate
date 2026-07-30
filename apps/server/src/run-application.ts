import { EnvironmentValidationError } from '@shipgate/config'

import { createApplicationContext, type ApplicationContext } from './application-context.js'
import { createBootstrapLogger, type ProcessKind } from './logger.js'

export interface StartedApplication {
  readonly startupFields?: Readonly<Record<string, unknown>>

  readonly waitUntilStopped: Promise<void>
}

export interface RunApplicationOptions {
  readonly processKind: ProcessKind

  start(context: ApplicationContext): Promise<StartedApplication> | StartedApplication
}

export async function runApplication(options: RunApplicationOptions): Promise<void> {
  const bootstrapLogger = createBootstrapLogger(options.processKind)

  let context: ApplicationContext

  try {
    context = createApplicationContext({
      processKind: options.processKind,
    })
  } catch (error) {
    logFatal(bootstrapLogger, error, 'configuration')

    process.exitCode = 1
    return
  }

  const removeProcessHandlers = installProcessHandlers(context)

  let stage: 'startup' | 'runtime' = 'startup'

  try {
    context.logger.info(
      {
        event: 'application.starting',

        runtime: {
          environment: context.runtimeConfig.environment,

          version: context.runtimeConfig.appVersion,

          logLevel: context.runtimeConfig.logLevel,
        },
      },
      'Application is starting',
    )

    const application = await options.start(context)

    stage = 'runtime'

    if (!context.shutdown.isShuttingDown) {
      context.logger.info(
        {
          event: 'application.started',

          startedAt: context.startedAt.toISOString(),

          ...application.startupFields,
        },
        'Application started',
      )
    }

    await application.waitUntilStopped

    const result = await context.shutdown.shutdown({
      type: 'completed',
    })

    if (result.failed) {
      process.exitCode = 1
    }
  } catch (error) {
    process.exitCode = 1

    logFatal(context.logger, error, stage)

    const result = await context.shutdown.shutdown({
      type: 'fatal',
      origin: stage,
    })

    if (result.failed) {
      process.exitCode = 1
    }
  } finally {
    removeProcessHandlers()
    context.logger.flush()
  }
}

function installProcessHandlers(context: ApplicationContext): () => void {
  const onSignal = (signal: NodeJS.Signals) => {
    void context.shutdown
      .shutdown({
        type: 'signal',
        signal,
      })
      .then((result) => {
        if (result.failed) {
          exitAfterFailedShutdown(context)
        }
      })
  }

  const onUncaughtException = (error: Error) => {
    process.exitCode = 1

    logFatal(context.logger, error, 'uncaughtException')

    void context.shutdown
      .shutdown({
        type: 'fatal',
        origin: 'uncaughtException',
      })
      .then((result) => {
        if (result.failed) {
          exitAfterFailedShutdown(context)
        }
      })
  }

  const onUnhandledRejection = (reason: unknown) => {
    process.exitCode = 1

    logFatal(context.logger, reason, 'unhandledRejection')

    void context.shutdown
      .shutdown({
        type: 'fatal',
        origin: 'unhandledRejection',
      })
      .then((result) => {
        if (result.failed) {
          exitAfterFailedShutdown(context)
        }
      })
  }

  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)

  process.once('uncaughtException', onUncaughtException)

  process.once('unhandledRejection', onUnhandledRejection)

  return () => {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)

    process.off('uncaughtException', onUncaughtException)

    process.off('unhandledRejection', onUnhandledRejection)
  }
}

function exitAfterFailedShutdown(context: ApplicationContext): never {
  context.logger.flush()
  process.exit(1)
}

function logFatal(logger: ApplicationContext['logger'], error: unknown, stage: string): void {
  const normalizedError = toError(error)

  logger.fatal(
    {
      event: 'application.fatal',
      stage,
      err: normalizedError,

      ...(normalizedError instanceof EnvironmentValidationError
        ? {
            environmentValidation: {
              scope: normalizedError.scope,
              issues: normalizedError.issues,
            },
          }
        : {}),
    },
    'Application failed',
  )
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
