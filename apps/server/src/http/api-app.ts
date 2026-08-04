import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'

import type { ApplicationContext } from '../application-context.js'
import { SESSION_COOKIE_NAME } from '../auth/cookies.js'
import { resolveCorrelationId } from '../correlation-id.js'
import { registerApiErrorHandling, sendApiNotFound } from './api-error.js'
import { createApiMetrics } from './metrics.js'
import { operationalRoutes } from './routes/operational.js'
import { apiV1Routes } from './routes/v1.js'
import { registerSpa, sendSpaIndex, shouldServeSpa } from './spa.js'

export async function buildApiApplication(context: ApplicationContext): Promise<FastifyInstance> {
  const fastifyLogger: FastifyBaseLogger = context.logger

  const app = Fastify({
    loggerInstance: fastifyLogger,

    bodyLimit: context.runtimeConfig.api.bodyLimitBytes,

    requestIdHeader: false,

    genReqId: (request) => resolveCorrelationId(request.headers['x-request-id']),

    forceCloseConnections: 'idle',
    return503OnClosing: true,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
  })

  app.setValidatorCompiler(TypeBoxValidatorCompiler)

  const metrics = context.runtimeConfig.api.metricsEnabled ? createApiMetrics(context) : undefined

  /*
   * swagger должен быть
   * зарегистрирован до routes.
   */
  await app.register(swagger, {
    openapi: {
      /*
       * TypeBox represents nullable values as JSON Schema unions containing
       * { type: 'null' }. That is valid in OpenAPI 3.1 and would be an invalid
       * schema (and generate `unknown`) under OpenAPI 3.0.
       */
      openapi: '3.1.0',

      info: {
        title: 'Shipgate API',

        description: 'Shipgate HTTP API.',

        version: context.runtimeConfig.appVersion,
      },

      servers: [
        {
          url: '/',

          description: 'Current Shipgate origin',
        },
      ],

      tags: [
        {
          name: 'Authentication',

          description: 'Shipgate browser session lifecycle.',
        },

        {
          name: 'Connections',

          description: 'GitHub connection and installation state.',
        },

        {
          name: 'Projects',

          description: 'Shipgate project configuration and repository topology.',
        },

        {
          name: 'Operations',

          description: 'Application health and readiness.',
        },

        {
          name: 'Diagnostics',

          description: 'Non-product infrastructure diagnostics.',
        },
      ],

      components: {
        securitySchemes: {
          shipgateSession: {
            type: 'apiKey',
            in: 'cookie',
            name: SESSION_COOKIE_NAME,
            description: 'HttpOnly Shipgate browser session cookie.',
          },
        },
      },
    },
  })

  await app.register(helmet, {
    global: true,
  })

  if (context.runtimeConfig.api.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: [...context.runtimeConfig.api.corsOrigins],

      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],

      allowedHeaders: ['content-type', 'authorization', 'x-csrf-token', 'x-request-id'],

      exposedHeaders: ['x-request-id'],

      credentials: true,
      maxAge: 600,
    })
  }

  registerApiErrorHandling(app)

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  if (metrics) {
    app.addHook('onResponse', async (request, reply) => {
      metrics.observeRequest(request, reply)
    })
  }

  await app.register(operationalRoutes, {
    context,
    metrics,
  })

  await app.register(apiV1Routes, {
    prefix: '/api/v1',
    context,
  })

  if (context.runtimeConfig.api.docsEnabled) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',

      staticCSP: true,

      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,

        displayRequestDuration: true,
      },

      logLevel: 'warn',
    })
  }

  const spaEnabled = context.runtimeConfig.environment === 'production'

  if (spaEnabled) {
    await registerSpa(app)
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (spaEnabled && shouldServeSpa(request)) {
      return sendSpaIndex(reply)
    }

    await sendApiNotFound(request, reply)
  })

  return app
}
