import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'
import type { ApplicationContext } from '../../application-context.js'
import {
  createGitHubWebhookPreParsingHook,
  registerGitHubWebhookIngressRequest,
} from '../../github-webhooks/ingress.js'
import { parseGitHubWebhookMetadata } from '../../github-webhooks/policy.js'
import { acceptGitHubWebhookDelivery } from '../../github-webhooks/store.js'
import { ApiHttpError } from '../api-error.js'
import { ApiErrorSchema } from '../schemas.js'

const Response = Type.Object(
  {
    deliveryId: Type.String(),
    status: Type.Union([
      Type.Literal('queued'),
      Type.Literal('duplicate'),
      Type.Literal('ignored'),
    ]),
  },
  { additionalProperties: false },
)
export const githubWebhookRoutes: FastifyPluginAsyncTypebox<{
  readonly context: ApplicationContext
}> = async (app, { context }) => {
  const limit = context.runtimeConfig.githubApp.webhookBodyLimitBytes
  registerGitHubWebhookIngressRequest(app)
  app.post(
    '/github/webhooks',
    {
      bodyLimit: limit,
      preParsing: createGitHubWebhookPreParsingHook(context, limit),
      schema: {
        hide: true,
        body: Type.Unknown(),
        response: { 200: Response, 202: Response, default: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const ingress = request.verifiedGitHubWebhookIngress
      if (!ingress)
        throw new ApiHttpError({
          statusCode: 500,
          code: 'GITHUB_WEBHOOK_INGRESS_NOT_VERIFIED',
          message: 'GitHub webhook ingress verification was not completed',
        })
      const metadata = parseGitHubWebhookMetadata(ingress.event, request.body)
      const accepted = await acceptGitHubWebhookDelivery({
        database: context.database,
        deliveryId: ingress.deliveryId,
        metadata,
        payloadHash: ingress.payloadHash,
        rawBody: ingress.rawBody,
        correlationId: request.id,
      })
      if (accepted.status === 'conflict') {
        request.log.error(
          {
            event: 'security.github_webhook.delivery_conflict',
            githubDeliveryId: ingress.deliveryId,
          },
          'GitHub delivery ID was reused with a different payload',
        )
        throw new ApiHttpError({
          statusCode: 409,
          code: 'GITHUB_WEBHOOK_DELIVERY_CONFLICT',
          message: 'GitHub delivery ID was already used for a different payload',
        })
      }
      return reply
        .code(accepted.status === 'queued' ? 202 : 200)
        .send({ deliveryId: ingress.deliveryId, status: accepted.status })
    },
  )
}
