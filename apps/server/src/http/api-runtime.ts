import type { AddressInfo } from 'node:net'

import type { ApplicationContext } from '../application-context.js'
import type { StartedApplication } from '../run-application.js'
import { buildApiApplication } from './api-app.js'

export async function startApi(context: ApplicationContext): Promise<StartedApplication> {
  const app = await buildApiApplication(context)

  const waitUntilStopped = new Promise<void>((resolve) => {
    app.server.once('close', resolve)
  })

  /*
   * Database hook зарегистрирован
   * раньше в ApplicationContext.
   *
   * Hooks идут в обратном порядке:
   * сначала Fastify, затем pool.
   */
  context.shutdown.addHook('fastify-api', async () => {
    await app.close()
  })

  await app.listen({
    host: context.runtimeConfig.api.host,

    port: context.runtimeConfig.api.port,
  })

  const address = app.server.address()

  const networkAddress =
    typeof address === 'object' && address !== null ? (address as AddressInfo) : undefined

  return {
    startupFields: {
      http: {
        host: networkAddress?.address,

        port: networkAddress?.port,

        apiPrefix: '/api/v1',

        docsEnabled: context.runtimeConfig.api.docsEnabled,

        docsPath: context.runtimeConfig.api.docsEnabled ? '/docs' : null,
      },
    },

    waitUntilStopped,
  }
}
