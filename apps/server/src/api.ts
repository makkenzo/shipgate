import { startHttpServer } from './http-server.js'
import { runApplication } from './run-application.js'

await runApplication({
  processKind: 'api',
  start: startHttpServer,
})
