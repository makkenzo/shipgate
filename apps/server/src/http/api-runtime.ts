import type { AddressInfo } from 'node:net'

import type { ApplicationContext } from '../application-context.js'
import type { StartedApplication } from '../run-application.js'
import { buildApiApplication } from './api-app.js'

export async function startApi(context: ApplicationContext): Promise<StartedApplication> {
  const app = await buildApiApplication(context)

  const waitUntilStopped = new Promise<void>((resolve) => {
    app.server.once('close', resolve)
  })

  if (context.shutdown.isShuttingDown) {
    await app.close()

    return {
      waitUntilStopped,
    }
  }

  /*
   * Database hook зарегистрирован
   * раньше в ApplicationContext.
   *
   * Hooks идут в обратном порядке:
   * сначала Fastify, затем pool.
   */
  try {
    context.shutdown.addHook('fastify-api', async () => {
      await app.close()
    })
  } catch (error) {
    if (!context.shutdown.isShuttingDown) {
      throw error
    }

    await app.close()

    return {
      waitUntilStopped,
    }
  }

  await app.listen({
    host: context.runtimeConfig.api.host,

    port: context.runtimeConfig.api.port,
  })

  /*
   * Shutdown may have completed its registered hook while listen was still
   * settling. Close once more so a late listener cannot outlive the process
   * lifecycle that owns it.
   */
  if (context.shutdown.isShuttingDown) {
    await app.close()
  }

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

        diagnosticsEnabled: context.runtimeConfig.api.diagnosticsEnabled,

        metricsEnabled: context.runtimeConfig.api.metricsEnabled,
      },
    },

    waitUntilStopped,
  }
}
