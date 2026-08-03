import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'
import {
  GitHubOAuthRequestError,
  GitHubUserAuthorizationNotFoundError,
  GitHubUserReauthorizationRequiredError,
} from '@shipgate/github'
import type { FastifyReply } from 'fastify'

import type { ApplicationContext } from '../../application-context.js'
import {
  createExpiredSessionCookies,
  createSessionCookies,
  parseCookies,
  SESSION_COOKIE_NAME,
} from '../../auth/cookies.js'
import { createOpaqueToken, createPkceChallenge } from '../../auth/crypto.js'
import { createGitHubAuthorizeUrl, loadGitHubUserIdentity } from '../../auth/github-identity.js'
import {
  consumeOAuthAttempt,
  createLoginSession,
  createOAuthAttempt,
  purgeExpiredAuthRecords,
  revokeSession,
  revokeUserSessions,
} from '../../auth/store.js'
import { GitHubRepositoryAccessVerificationError } from '../../github-access/index.js'
import { ApiHttpError } from '../api-error.js'
import {
  AuthSessionResponseSchema,
  CsrfHeadersSchema,
  EmptyMutationBodySchema,
  GitHubCallbackQuerySchema,
  GitHubLoginQuerySchema,
} from '../auth-schemas.js'
import { ApiErrorSchema } from '../schemas.js'
import { requireAuthenticatedSession, requireCsrfProtection } from '../session-middleware.js'

interface AuthRoutesOptions {
  readonly context: ApplicationContext
}

export const authRoutes: FastifyPluginAsyncTypebox<AuthRoutesOptions> = async (app, options) => {
  const { context } = options

  app.get(
    '/auth/github',
    {
      schema: {
        hide: true,
        operationId: 'startGitHubLogin',
        summary: 'Start GitHub login',
        tags: ['Authentication'],
        querystring: GitHubLoginQuerySchema,
      },
    },
    async (request, reply) => {
      const configuration = getAuthConfiguration(context)
      const state = createOpaqueToken()
      const pkceVerifier = createOpaqueToken(64)
      const returnTo = normalizeReturnTo(request.query.returnTo, configuration.appOrigin)
      const expiresAt = new Date(
        Date.now() + context.runtimeConfig.auth.oauthAttemptTtlSeconds * 1_000,
      )

      await purgeExpiredAuthRecords(context.database)
      await createOAuthAttempt({
        database: context.database,
        state,
        pkceVerifier,
        returnTo,
        expiresAt,
      })

      request.log.info(
        {
          event: 'security.auth.login_started',
          oauthAttemptExpiresAt: expiresAt.toISOString(),
        },
        'Started GitHub authorization flow',
      )

      const location = createGitHubAuthorizeUrl({
        oauthOrigin: context.runtimeConfig.githubApp.oauthUrl,
        clientId: configuration.clientId,
        callbackUrl: configuration.callbackUrl,
        state,
        codeChallenge: createPkceChallenge(pkceVerifier),
      })

      return reply.code(302).header('cache-control', 'no-store').header('location', location).send()
    },
  )

  app.get(
    '/auth/github/callback',
    {
      schema: {
        hide: true,
        operationId: 'completeGitHubLogin',
        summary: 'Complete GitHub login',
        tags: ['Authentication'],
        querystring: GitHubCallbackQuerySchema,
      },
    },
    async (request, reply) => {
      const configuration = getAuthConfiguration(context)

      if (!request.query.state) {
        if (request.query.setup_action) {
          request.log.info(
            {
              event: 'security.auth.installation_redirect_received',
              setupAction: request.query.setup_action,
              installationId: request.query.installation_id,
            },
            'Received GitHub App post-installation redirect',
          )

          return redirectInstallationSetupToLogin(reply, configuration.appOrigin, {
            setupAction: request.query.setup_action,
            ...(request.query.installation_id
              ? { installationId: request.query.installation_id }
              : {}),
          })
        }

        throw new ApiHttpError({
          statusCode: 400,
          code: 'MISSING_OAUTH_STATE',
          message: 'GitHub callback did not include OAuth state',
        })
      }

      const attempt = await consumeOAuthAttempt({
        database: context.database,
        state: request.query.state,
      })

      if (!attempt) {
        request.log.warn(
          {
            event: 'security.auth.login_failed',
            reason: 'invalid_or_expired_state',
          },
          'Rejected GitHub callback with invalid OAuth state',
        )

        throw new ApiHttpError({
          statusCode: 400,
          code: 'INVALID_OAUTH_STATE',
          message: 'GitHub OAuth state is invalid, expired, or already used',
        })
      }

      if (request.query.error) {
        request.log.warn(
          {
            event: 'security.auth.login_failed',
            reason: 'github_authorization_denied',
            githubError: request.query.error,
          },
          'GitHub authorization was not completed',
        )

        return redirectWithAuthResult(reply, configuration.appOrigin, attempt.returnTo, {
          status: 'failed',
          code: request.query.error,
        })
      }

      if (!request.query.code) {
        throw new ApiHttpError({
          statusCode: 400,
          code: 'MISSING_AUTHORIZATION_CODE',
          message: 'GitHub callback did not include an authorization code',
        })
      }

      let authorizedUserId: number | undefined

      try {
        const authorization = await context.githubAuth.authorizeUser({
          code: request.query.code,
          redirectUri: configuration.callbackUrl,
          codeVerifier: attempt.pkceVerifier,
        })
        authorizedUserId = authorization.userId

        const client = await context.githubAuth.getUserClient(authorization.userId)
        const identity = await loadGitHubUserIdentity(client)

        if (identity.githubUserId !== authorization.userId) {
          throw new Error('GitHub user identity changed during authorization')
        }

        const installations = await context.githubRepositoryAccess.reconcileUserInstallations({
          githubUserId: identity.githubUserId,
          userClient: client,
          installations: identity.installations,
        })
        const user = {
          ...identity,
          installations,
        }

        const previousSessionToken = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME]
        const expiresAt = new Date(
          Date.now() + context.runtimeConfig.auth.sessionTtlSeconds * 1_000,
        )
        const created = await createLoginSession({
          database: context.database,
          user,
          expiresAt,
          ...(previousSessionToken ? { previousSessionToken } : {}),
          ...(request.headers['user-agent']
            ? { userAgent: request.headers['user-agent'].slice(0, 512) }
            : {}),
        })

        reply.header(
          'set-cookie',
          createSessionCookies({
            sessionToken: created.sessionToken,
            csrfToken: created.csrfToken,
            expiresAt,
          }),
        )

        request.log.info(
          {
            event: 'security.auth.login_succeeded',
            sessionId: created.session.id,
            githubUserId: user.githubUserId,
            installationCount: user.installations.length,
          },
          'GitHub login created a Shipgate session',
        )

        return redirectWithAuthResult(reply, configuration.appOrigin, attempt.returnTo, {
          status: 'succeeded',
        })
      } catch (error) {
        if (authorizedUserId !== undefined) {
          await context.githubAuth.revokeUser(authorizedUserId)
          await revokeUserSessions(context.database, authorizedUserId, 'login_failed')
        }

        request.log.error(
          {
            event: 'security.auth.login_failed',
            reason: classifyGitHubAuthFailure(error),
            err: error,
          },
          'GitHub login failed',
        )

        throw mapGitHubAuthError(error)
      }
    },
  )

  app.get(
    '/auth/session',
    {
      schema: {
        operationId: 'getAuthSession',
        summary: 'Get the current Shipgate session',
        tags: ['Authentication'],
        response: {
          200: AuthSessionResponseSchema,
          default: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store')

      const session = request.shipgateSession

      if (!session) {
        return {
          authenticated: false as const,
        }
      }

      return {
        authenticated: true as const,
        session: {
          id: session.id,
          expiresAt: session.expiresAt.toISOString(),
        },
        user: {
          id: session.user.githubUserId,
          login: session.user.login,
          avatarUrl: session.user.avatarUrl,
          displayName: session.user.displayName,
          email: session.user.email,
          htmlUrl: session.user.htmlUrl,
          installations: [...session.user.installations],
        },
      }
    },
  )

  app.post(
    '/auth/logout',
    {
      preHandler: [requireAuthenticatedSession, requireCsrfProtection],
      schema: {
        operationId: 'logout',
        summary: 'Revoke the current Shipgate session',
        tags: ['Authentication'],
        security: [{ shipgateSession: [] }],
        headers: CsrfHeadersSchema,
        body: EmptyMutationBodySchema,
        response: {
          204: Type.Null(),
          default: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const session = requireRequestSession(request.shipgateSession)

      await revokeSession(context.database, session.id, 'logout')
      reply.header('set-cookie', createExpiredSessionCookies())

      request.log.info(
        {
          event: 'security.auth.logout',
          sessionId: session.id,
          githubUserId: session.githubUserId,
        },
        'Revoked Shipgate session',
      )

      return reply.code(204).send(null)
    },
  )

  app.post(
    '/auth/disconnect',
    {
      preHandler: [requireAuthenticatedSession, requireCsrfProtection],
      schema: {
        operationId: 'disconnectGitHub',
        summary: 'Disconnect GitHub and revoke all Shipgate sessions',
        tags: ['Authentication'],
        security: [{ shipgateSession: [] }],
        headers: CsrfHeadersSchema,
        body: EmptyMutationBodySchema,
        response: {
          204: Type.Null(),
          default: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const session = requireRequestSession(request.shipgateSession)

      try {
        await context.githubAuth.disconnectUser(session.githubUserId)
      } catch (error) {
        request.log.error(
          {
            event: 'security.auth.disconnect_failed',
            sessionId: session.id,
            githubUserId: session.githubUserId,
            err: error,
          },
          'Unable to revoke GitHub authorization',
        )

        throw mapGitHubAuthError(error)
      }

      context.githubRepositoryAccess.invalidateUser(session.githubUserId)
      reply.header('set-cookie', createExpiredSessionCookies())

      request.log.info(
        {
          event: 'security.auth.disconnect',
          sessionId: session.id,
          githubUserId: session.githubUserId,
        },
        'Revoked GitHub authorization and Shipgate sessions',
      )

      return reply.code(204).send(null)
    },
  )
}

function getAuthConfiguration(context: ApplicationContext): {
  readonly appOrigin: string
  readonly clientId: string
  readonly callbackUrl: string
} {
  const appOrigin = context.runtimeConfig.appOrigin
  const clientId = context.runtimeConfig.githubApp.clientId

  if (!appOrigin || !clientId) {
    throw new ApiHttpError({
      statusCode: 503,
      code: 'GITHUB_LOGIN_NOT_CONFIGURED',
      message: 'GitHub login is not configured',
    })
  }

  return {
    appOrigin,
    clientId,
    callbackUrl: new URL('/api/v1/auth/github/callback', appOrigin).href,
  }
}

function normalizeReturnTo(value: string | undefined, appOrigin: string): string {
  if (!value) {
    return '/'
  }

  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new ApiHttpError({
      statusCode: 400,
      code: 'INVALID_RETURN_URL',
      message: 'returnTo must be an absolute path on the Shipgate origin',
    })
  }

  const url = new URL(value, appOrigin)

  if (url.origin !== appOrigin) {
    throw new ApiHttpError({
      statusCode: 400,
      code: 'INVALID_RETURN_URL',
      message: 'returnTo must stay on the Shipgate origin',
    })
  }

  return `${url.pathname}${url.search}${url.hash}`
}

function redirectInstallationSetupToLogin(
  reply: FastifyReply,
  appOrigin: string,
  input: {
    readonly installationId?: string
    readonly setupAction: 'install' | 'update' | 'request'
  },
): FastifyReply {
  const returnTo = new URL('/setup', appOrigin)
  returnTo.searchParams.set('installation_action', input.setupAction)

  if (input.installationId) {
    returnTo.searchParams.set('installation_id', input.installationId)
  }

  const login = new URL('/api/v1/auth/github', appOrigin)
  login.searchParams.set('returnTo', `${returnTo.pathname}${returnTo.search}`)

  return reply.code(302).header('cache-control', 'no-store').header('location', login.href).send()
}

function redirectWithAuthResult(
  reply: FastifyReply,
  appOrigin: string,
  returnTo: string,
  result: {
    readonly status: 'succeeded' | 'failed'
    readonly code?: string
  },
) {
  const location = new URL(returnTo, appOrigin)

  location.searchParams.set('auth', result.status)

  if (result.code) {
    location.searchParams.set('auth_error', result.code.slice(0, 128))
  }

  return reply
    .code(302)
    .header('cache-control', 'no-store')
    .header('location', location.href)
    .send()
}

function requireRequestSession<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new ApiHttpError({
      statusCode: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: 'A valid Shipgate session is required',
    })
  }

  return value
}

function classifyGitHubAuthFailure(error: unknown): string {
  if (
    error instanceof GitHubUserAuthorizationNotFoundError ||
    error instanceof GitHubUserReauthorizationRequiredError
  ) {
    return 'github_authorization_revoked'
  }

  if (error instanceof GitHubOAuthRequestError) {
    return error.code ?? 'github_oauth_error'
  }

  if (error instanceof GitHubRepositoryAccessVerificationError) {
    return `repository_access_verification_failed:${error.phase}`
  }

  return 'unexpected_error'
}

function mapGitHubAuthError(error: unknown): ApiHttpError {
  if (
    error instanceof GitHubUserAuthorizationNotFoundError ||
    error instanceof GitHubUserReauthorizationRequiredError
  ) {
    return new ApiHttpError({
      statusCode: 401,
      code: 'GITHUB_REAUTHORIZATION_REQUIRED',
      message: 'GitHub authorization was revoked or expired',
      cause: error,
    })
  }

  if (error instanceof GitHubOAuthRequestError) {
    return new ApiHttpError({
      statusCode: 502,
      code: 'GITHUB_OAUTH_FAILED',
      message: 'GitHub authorization request failed',
      details: {
        githubCode: error.code,
        githubRequestId: error.requestId,
      },
      cause: error,
    })
  }

  if (error instanceof GitHubRepositoryAccessVerificationError) {
    return new ApiHttpError({
      statusCode: 502,
      code: 'GITHUB_REPOSITORY_ACCESS_VERIFICATION_FAILED',
      message: 'GitHub repository access could not be verified',
      details: {
        verificationPhase: error.phase,
        installationId: error.installationId,
        ...(error.status !== undefined ? { githubStatus: error.status } : {}),
      },
      cause: error,
    })
  }

  return new ApiHttpError({
    statusCode: 502,
    code: 'GITHUB_AUTHENTICATION_FAILED',
    message: 'GitHub authentication could not be completed',
    cause: error,
  })
}
