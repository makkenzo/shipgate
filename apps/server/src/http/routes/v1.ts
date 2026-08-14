import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

import type { ApplicationContext } from '../../application-context.js'
import { enforceJsonContentType } from '../content-type.js'
import { registerSessionMiddleware } from '../session-middleware.js'
import { authRoutes } from './auth.js'
import { connectionRoutes } from './connection.js'
import { diagnosticJobRoutes } from './diagnostic-jobs.js'
import { githubWebhookRoutes } from './github-webhooks.js'
import { projectRoutes } from './projects.js'
import { releasePlanningRoutes } from './release-planning.js'

interface ApiV1RoutesOptions {
  readonly context: ApplicationContext
}

export const apiV1Routes: FastifyPluginAsyncTypebox<ApiV1RoutesOptions> = async (app, options) => {
  app.addHook('onRequest', enforceJsonContentType)

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store')

    return payload
  })

  await app.register(githubWebhookRoutes, { context: options.context })

  registerSessionMiddleware(app, options.context)

  await app.register(authRoutes, {
    context: options.context,
  })

  await app.register(connectionRoutes, {
    context: options.context,
  })

  await app.register(projectRoutes, {
    context: options.context,
  })

  await app.register(releasePlanningRoutes, { context: options.context })

  if (options.context.runtimeConfig.api.diagnosticsEnabled) {
    await app.register(diagnosticJobRoutes, {
      context: options.context,
    })
  }
}
