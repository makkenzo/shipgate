import { runApplication } from './run-application.js'
import { startWorker } from './worker-runtime.js'

await runApplication({
  processKind: 'worker',
  validateGitHubApp: true,
  start: startWorker,
})
