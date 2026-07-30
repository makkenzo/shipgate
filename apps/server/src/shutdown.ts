import type { Logger } from 'pino'

export type ShutdownReason =
  | {
      readonly type: 'signal'
      readonly signal: NodeJS.Signals
    }
  | {
      readonly type: 'fatal'
      readonly origin: string
    }
  | {
      readonly type: 'completed'
    }

export interface ShutdownResult {
  readonly failed: boolean
  readonly timedOut: boolean
}

export type ShutdownHook = () => Promise<void> | void

interface RegisteredShutdownHook {
  readonly name: string
  readonly run: ShutdownHook
}

export interface ShutdownManager {
  readonly signal: AbortSignal
  readonly isShuttingDown: boolean

  addHook(name: string, hook: ShutdownHook): () => void

  shutdown(reason: ShutdownReason): Promise<ShutdownResult>
}

export interface CreateShutdownManagerOptions {
  readonly logger: Logger
  readonly timeoutMs: number
}

export function createShutdownManager(options: CreateShutdownManagerOptions): ShutdownManager {
  const { logger, timeoutMs } = options
  const controller = new AbortController()
  const hooks: RegisteredShutdownHook[] = []

  let shutdownPromise: Promise<ShutdownResult> | undefined

  return {
    signal: controller.signal,

    get isShuttingDown() {
      return shutdownPromise !== undefined
    },

    addHook(name, hook) {
      if (shutdownPromise) {
        throw new Error(`Cannot register shutdown hook "${name}" after shutdown has started`)
      }

      const registeredHook = {
        name,
        run: hook,
      }

      hooks.push(registeredHook)

      return () => {
        const index = hooks.indexOf(registeredHook)

        if (index >= 0) {
          hooks.splice(index, 1)
        }
      }
    },

    shutdown(reason) {
      shutdownPromise ??= performShutdown({
        controller,
        hooks,
        logger,
        reason,
        timeoutMs,
      })

      return shutdownPromise
    },
  }
}

interface PerformShutdownOptions {
  readonly controller: AbortController
  readonly hooks: readonly RegisteredShutdownHook[]
  readonly logger: Logger
  readonly reason: ShutdownReason
  readonly timeoutMs: number
}

async function performShutdown(options: PerformShutdownOptions): Promise<ShutdownResult> {
  const { controller, hooks, logger, reason, timeoutMs } = options

  const reasonFields = getReasonFields(reason)

  logger.info(
    {
      event: 'application.stopping',
      ...reasonFields,
      shutdownTimeoutMs: timeoutMs,
    },
    'Application is stopping',
  )

  controller.abort(reason)

  const shutdownWork = runHooks([...hooks].reverse(), logger)

  let timer: NodeJS.Timeout | undefined

  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })

  const result = await Promise.race([
    shutdownWork.then((failed) => ({
      type: 'completed' as const,
      failed,
    })),

    timeout.then(() => ({
      type: 'timeout' as const,
      failed: true,
    })),
  ])

  if (timer) {
    clearTimeout(timer)
  }

  if (result.type === 'timeout') {
    logger.fatal(
      {
        event: 'application.fatal',
        stage: 'shutdown',
        reason: 'shutdown_timeout',
        shutdownTimeoutMs: timeoutMs,
      },
      'Application shutdown timed out',
    )

    return {
      failed: true,
      timedOut: true,
    }
  }

  logger.info(
    {
      event: 'application.stopped',
      ...reasonFields,
      failed: result.failed,
    },
    'Application stopped',
  )

  return {
    failed: result.failed,
    timedOut: false,
  }
}

async function runHooks(
  hooks: readonly RegisteredShutdownHook[],
  logger: Logger,
): Promise<boolean> {
  let failed = false

  for (const hook of hooks) {
    try {
      logger.debug(
        {
          event: 'application.shutdown_hook.started',
          hook: hook.name,
        },
        'Shutdown hook started',
      )

      await hook.run()

      logger.debug(
        {
          event: 'application.shutdown_hook.completed',
          hook: hook.name,
        },
        'Shutdown hook completed',
      )
    } catch (error) {
      failed = true

      logger.error(
        {
          event: 'application.shutdown_hook.failed',
          hook: hook.name,
          err: toError(error),
        },
        'Shutdown hook failed',
      )
    }
  }

  return failed
}

function getReasonFields(reason: ShutdownReason): Record<string, unknown> {
  switch (reason.type) {
    case 'signal':
      return {
        reason: reason.type,
        signal: reason.signal,
      }

    case 'fatal':
      return {
        reason: reason.type,
        origin: reason.origin,
      }

    case 'completed':
      return {
        reason: reason.type,
      }
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
