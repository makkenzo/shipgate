import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

import type { ApplicationContext } from '../../application-context.js'
import { enforceJsonContentType } from '../content-type.js'
import { diagnosticJobRoutes } from './diagnostic-jobs.js'

interface ApiV1RoutesOptions {
  readonly context: ApplicationContext
}

export const apiV1Routes: FastifyPluginAsyncTypebox<ApiV1RoutesOptions> = async (app, options) => {
  app.addHook('onRequest', enforceJsonContentType)

  await app.register(diagnosticJobRoutes, {
    context: options.context,
  })
}
