import { assertDatabaseReady } from '@shipgate/database'

import type { ApplicationContext } from './application-context.js'
import type { StartedApplication } from './run-application.js'

export async function startWorker(context: ApplicationContext): Promise<StartedApplication> {
  await assertDatabaseReady(
    context.database.kysely,
    context.runtimeConfig.database.readinessTimeoutMs,
  )

  const keepAlive = setInterval(() => undefined, 60_000)

  context.shutdown.addHook('worker-runtime', () => {
    clearInterval(keepAlive)
  })

  return {
    startupFields: {
      worker: {
        state: 'ready',
      },

      database: {
        state: 'ready',
      },
    },

    waitUntilStopped: waitForAbort(context.shutdown.signal),
  }
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), {
      once: true,
    })
  })
}
