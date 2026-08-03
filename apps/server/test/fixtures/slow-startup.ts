import { setTimeout as delay } from 'node:timers/promises'

import { runApplication } from '../../src/run-application.js'

await runApplication({
  processKind: 'worker',

  async start() {
    await delay(1_500)

    return {
      waitUntilStopped: new Promise<void>(() => undefined),
    }
  },
})
