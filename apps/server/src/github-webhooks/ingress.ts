import { Readable } from 'node:stream'
import { hashGitHubWebhookPayload, verifyGitHubWebhookSignature } from '@shipgate/github'
import type { FastifyInstance, preParsingAsyncHookHandler } from 'fastify'
import type { ApplicationContext } from '../application-context.js'
import { ApiHttpError } from '../http/api-error.js'
import { assertGitHubWebhookEventAllowed } from './policy.js'

const deliveryPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const eventPattern = /^[a-z][a-z0-9_]{0,63}$/
const jsonType = /^application\/json(?:\s*;.*)?$/i
export interface VerifiedGitHubWebhookIngress {
  readonly deliveryId: string
  readonly event: string
  readonly rawBody: Buffer
  readonly payloadHash: string
}
declare module 'fastify' {
  interface FastifyRequest {
    verifiedGitHubWebhookIngress: VerifiedGitHubWebhookIngress | undefined
  }
}
export function registerGitHubWebhookIngressRequest(app: FastifyInstance): void {
  app.decorateRequest('verifiedGitHubWebhookIngress')
}
export function createGitHubWebhookPreParsingHook(
  context: ApplicationContext,
  limit: number,
): preParsingAsyncHookHandler {
  return async (request, _reply, payload) => {
    const secret = context.githubSecrets.webhookSecret
    if (!secret)
      throw new ApiHttpError({
        statusCode: 503,
        code: 'GITHUB_WEBHOOK_NOT_CONFIGURED',
        message: 'GitHub webhook ingress is not configured',
      })
    const contentType = request.headers['content-type']
    if (typeof contentType !== 'string' || !jsonType.test(contentType))
      throw new ApiHttpError({
        statusCode: 415,
        code: 'UNSUPPORTED_GITHUB_WEBHOOK_MEDIA_TYPE',
        message: 'GitHub webhook Content-Type must be application/json',
      })
    if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')
      throw new ApiHttpError({
        statusCode: 415,
        code: 'UNSUPPORTED_GITHUB_WEBHOOK_CONTENT_ENCODING',
        message: 'GitHub webhook Content-Encoding must be identity',
      })
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of payload as AsyncIterable<Buffer | string | Uint8Array>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limit)
        throw new ApiHttpError({
          statusCode: 413,
          code: 'GITHUB_WEBHOOK_BODY_TOO_LARGE',
          message: 'GitHub webhook payload is too large',
        })
      chunks.push(buffer)
    }
    const rawBody = Buffer.concat(chunks, size)
    const signature =
      typeof request.headers['x-hub-signature-256'] === 'string'
        ? request.headers['x-hub-signature-256']
        : undefined
    if (!verifyGitHubWebhookSignature({ secret, rawBody, signature })) {
      request.log.warn(
        { event: 'security.github_webhook.signature_rejected', bodyBytes: size },
        'Rejected GitHub webhook with invalid signature',
      )
      throw new ApiHttpError({
        statusCode: 401,
        code: 'INVALID_GITHUB_WEBHOOK_SIGNATURE',
        message: 'GitHub webhook signature is missing or invalid',
      })
    }
    const deliveryId = request.headers['x-github-delivery']
    const event = request.headers['x-github-event']
    if (typeof deliveryId !== 'string' || !deliveryPattern.test(deliveryId))
      throw new ApiHttpError({
        statusCode: 400,
        code: 'INVALID_GITHUB_DELIVERY_ID',
        message: 'X-GitHub-Delivery must contain a valid GUID',
      })
    if (typeof event !== 'string' || !eventPattern.test(event))
      throw new ApiHttpError({
        statusCode: 400,
        code: 'INVALID_GITHUB_WEBHOOK_EVENT',
        message: 'X-GitHub-Event is missing or invalid',
      })
    assertGitHubWebhookEventAllowed(event)
    request.verifiedGitHubWebhookIngress = {
      deliveryId: deliveryId.toLowerCase(),
      event,
      rawBody,
      payloadHash: hashGitHubWebhookPayload(rawBody),
    }
    const replacement = Readable.from([rawBody]) as Readable & { receivedEncodedLength?: number }
    replacement.receivedEncodedLength = rawBody.length
    return replacement
  }
}
