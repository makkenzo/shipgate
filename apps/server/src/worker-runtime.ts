import type { ApplicationContext } from './application-context.js'
import type { StartedApplication } from './run-application.js'

export function startWorker(context: ApplicationContext): StartedApplication {
  const keepAlive = setInterval(() => undefined, 60_000)

  context.shutdown.addHook('worker-runtime', () => {
    clearInterval(keepAlive)
  })

  return {
    startupFields: {
      worker: {
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
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}
