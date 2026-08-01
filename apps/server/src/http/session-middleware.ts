import type { FastifyInstance, FastifyRequest } from 'fastify'

import type { ApplicationContext } from '../application-context.js'
import { CSRF_COOKIE_NAME, parseCookies, SESSION_COOKIE_NAME } from '../auth/cookies.js'
import { hashOpaqueToken, secureStringEqual } from '../auth/crypto.js'
import type { AuthenticatedSession } from '../auth/model.js'
import { findActiveSession } from '../auth/store.js'
import { ApiHttpError } from './api-error.js'

declare module 'fastify' {
  interface FastifyRequest {
    shipgateSession: AuthenticatedSession | undefined
  }
}

export function registerSessionMiddleware(app: FastifyInstance, context: ApplicationContext): void {
  app.decorateRequest('shipgateSession')

  app.addHook('onRequest', async (request) => {
    const cookies = parseCookies(request.headers.cookie)
    const sessionToken = cookies[SESSION_COOKIE_NAME]

    if (!sessionToken) {
      request.shipgateSession = undefined
      return
    }

    request.shipgateSession = await findActiveSession(context.database, sessionToken)
  })
}

export async function requireAuthenticatedSession(request: FastifyRequest): Promise<void> {
  if (!request.shipgateSession) {
    throw new ApiHttpError({
      statusCode: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: 'A valid Shipgate session is required',
    })
  }
}

export async function requireCsrfProtection(request: FastifyRequest): Promise<void> {
  const session = request.shipgateSession

  if (!session) {
    throw new ApiHttpError({
      statusCode: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: 'A valid Shipgate session is required',
    })
  }

  const headerToken = request.headers['x-csrf-token']
  const cookieToken = parseCookies(request.headers.cookie)[CSRF_COOKIE_NAME]
  const valid =
    typeof headerToken === 'string' &&
    typeof cookieToken === 'string' &&
    secureStringEqual(headerToken, cookieToken) &&
    secureStringEqual(hashOpaqueToken(headerToken), session.csrfTokenHash)

  if (!valid) {
    request.log.warn(
      {
        event: 'security.auth.csrf_rejected',
        sessionId: session.id,
        githubUserId: session.githubUserId,
      },
      'Rejected mutating request with invalid CSRF token',
    )

    throw new ApiHttpError({
      statusCode: 403,
      code: 'CSRF_VALIDATION_FAILED',
      message: 'CSRF token is missing or invalid',
    })
  }
}
