import { runApplication } from '../../src/run-application.js'

await runApplication({
  processKind: 'worker',

  start(context) {
    setInterval(() => undefined, 1_000)

    context.shutdown.addHook('hanging-test-hook', async () => {
      await new Promise<never>(() => undefined)
    })

    return {
      waitUntilStopped: new Promise<void>(() => undefined),
    }
  },
})
