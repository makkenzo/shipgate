import type { FastifyRequest } from 'fastify'

import { ApiHttpError } from './api-error.js'

const methodsRequiringJson = new Set(['POST', 'PUT', 'PATCH'])

const jsonContentTypePattern = /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;.*)?$/i

export async function enforceJsonContentType(request: FastifyRequest): Promise<void> {
  if (!methodsRequiringJson.has(request.method)) {
    return
  }

  const contentType = request.headers['content-type']

  if (typeof contentType !== 'string' || !jsonContentTypePattern.test(contentType)) {
    throw new ApiHttpError({
      statusCode: 415,

      code: 'UNSUPPORTED_MEDIA_TYPE',

      message: 'Content-Type must be application/json',
    })
  }
}
