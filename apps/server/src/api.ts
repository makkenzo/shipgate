import { startApi } from './http/api-runtime.js'
import { runApplication } from './run-application.js'

await runApplication({
  processKind: 'api',
  start: startApi,
})
