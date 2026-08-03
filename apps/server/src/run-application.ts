import { EnvironmentValidationError } from '@shipgate/config'
import { GitHubAppValidationError } from '@shipgate/github'

import { type ApplicationContext, createApplicationContext } from './application-context.js'
import { validateGitHubAppAtStartup } from './github-startup.js'
import { createBootstrapLogger, type ProcessKind } from './logger.js'

export interface StartedApplication {
  readonly startupFields?: Readonly<Record<string, unknown>>

  readonly waitUntilStopped: Promise<void>
}

export interface RunApplicationOptions {
  readonly processKind: ProcessKind
  readonly validateGitHubApp?: boolean

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

  let phase: 'startup' | 'runtime' = 'startup'

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

    if (options.validateGitHubApp) {
      await validateGitHubAppAtStartup(context)
    }

    if (await finishInterruptedStartup(context)) {
      return
    }

    const application = await options.start(context)

    if (await finishInterruptedStartup(context)) {
      return
    }

    phase = 'runtime'

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
    if (await finishInterruptedStartup(context)) {
      return
    }

    process.exitCode = 1

    logFatal(context.logger, error, phase)

    const result = await context.shutdown.shutdown({
      type: 'fatal',
      origin: phase,
    })

    if (result.failed) {
      process.exitCode = 1
    }
  } finally {
    removeProcessHandlers()
    context.logger.flush()
  }
}

async function finishInterruptedStartup(context: ApplicationContext): Promise<boolean> {
  if (!context.shutdown.isShuttingDown) {
    return false
  }

  const result = await context.shutdown.shutdown({
    type: 'completed',
  })

  if (result.failed) {
    process.exitCode = 1
  }

  return true
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

function logFatal(logger: ApplicationContext['logger'], error: unknown, phase: string): void {
  const normalizedError = toError(error)

  logger.fatal(
    {
      event: 'application.fatal',
      phase,
      err: normalizedError,

      ...(normalizedError instanceof EnvironmentValidationError
        ? {
            environmentValidation: {
              scope: normalizedError.scope,
              issues: normalizedError.issues,
            },
          }
        : {}),

      ...(normalizedError instanceof GitHubAppValidationError
        ? {
            githubAppValidation: {
              checks: normalizedError.report.checks,
              remoteVerificationLimitations: normalizedError.report.remoteVerificationLimitations,
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
