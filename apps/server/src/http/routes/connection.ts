import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'

import type { ApplicationContext } from '../../application-context.js'
import { createExpiredSessionCookies } from '../../auth/cookies.js'
import type { AuthenticatedSession } from '../../auth/model.js'
import {
  deleteLocalAccount,
  getConnectionInstallation,
  listConnectionInstallations,
} from '../../connection/store.js'
import { ApiHttpError } from '../api-error.js'
import { CsrfHeadersSchema } from '../auth-schemas.js'
import {
  ConnectionConfigurationSchema,
  InstallationDetailSchema,
  InstallationListSchema,
  InstallationParamsSchema,
} from '../connection-schemas.js'
import { ApiErrorSchema } from '../schemas.js'
import { requireAuthenticatedSession, requireCsrfProtection } from '../session-middleware.js'

export const connectionRoutes: FastifyPluginAsyncTypebox<{
  readonly context: ApplicationContext
}> = async (app, { context }) => {
  app.get(
    '/connection',
    {
      schema: {
        operationId: 'getConnectionConfiguration',
        summary: 'Get GitHub connection configuration',
        tags: ['Connections'],
        response: {
          200: ConnectionConfigurationSchema,
          default: ApiErrorSchema,
        },
      },
    },
    async () => {
      const githubLoginConfigured = Boolean(
        context.runtimeConfig.appOrigin && context.runtimeConfig.githubApp.clientId,
      )
      const slug = context.runtimeConfig.githubApp.slug

      return {
        githubLoginConfigured,
        githubInstallationConfigured: Boolean(slug),
        loginUrl: '/api/v1/auth/github?returnTo=%2Fsetup',
        installUrl: slug
          ? new URL(
              `/apps/${encodeURIComponent(slug)}/installations/new`,
              context.runtimeConfig.githubApp.oauthUrl,
            ).href
          : null,
      }
    },
  )

  app.get(
    '/installations',
    {
      preHandler: [requireAuthenticatedSession],
      schema: {
        operationId: 'getInstallations',
        summary: 'List installations visible to the current user',
        tags: ['Connections'],
        security: [{ shipgateSession: [] }],
        response: {
          200: InstallationListSchema,
          default: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)

      let installations = await listConnectionInstallations(context.database, session.githubUserId)

      if (installations.length === 0 && session.user.installations.length > 0) {
        await reconcileSessionInstallations(context, session)
        installations = await listConnectionInstallations(context.database, session.githubUserId)
      }

      return {
        installations: installations.map((installation) => ({
          ...installation,
          permissions: [...installation.permissions],
        })),
      }
    },
  )

  app.get(
    '/installations/:installationId',
    {
      preHandler: [requireAuthenticatedSession],
      schema: {
        operationId: 'getInstallation',
        summary: 'Get an installation visible to the current user',
        tags: ['Connections'],
        security: [{ shipgateSession: [] }],
        params: InstallationParamsSchema,
        response: {
          200: InstallationDetailSchema,
          default: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const session = requireSession(request.shipgateSession)
      const installationId = Number(request.params.installationId)
      let installation = await getConnectionInstallation(
        context.database,
        session.githubUserId,
        installationId,
      )

      if (
        !installation &&
        session.user.installations.some((candidate) => candidate.id === installationId)
      ) {
        await reconcileSessionInstallations(context, session)
        installation = await getConnectionInstallation(
          context.database,
          session.githubUserId,
          installationId,
        )
      }

      if (!installation) {
        throw new ApiHttpError({
          statusCode: 404,
          code: 'GITHUB_INSTALLATION_NOT_FOUND',
          message: 'GitHub installation was not found for the current user',
        })
      }

      return {
        ...installation,
        permissions: [...installation.permissions],
        repositories: [...installation.repositories],
        manageUrl: new URL(
          `/settings/installations/${encodeURIComponent(String(installationId))}`,
          context.runtimeConfig.githubApp.oauthUrl,
        ).href,
      }
    },
  )

  app.delete(
    '/account',
    {
      preHandler: [requireAuthenticatedSession, requireCsrfProtection],
      schema: {
        operationId: 'deleteLocalAccount',
        summary: 'Delete the local Shipgate account',
        tags: ['Connections'],
        security: [{ shipgateSession: [] }],
        headers: CsrfHeadersSchema,
        response: {
          204: Type.Null(),
          default: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const session = requireSession(request.shipgateSession)

      await context.githubAuth.revokeUser(session.githubUserId)
      await deleteLocalAccount(context.database, session.githubUserId)
      context.githubRepositoryAccess.invalidateUser(session.githubUserId)
      reply.header('set-cookie', createExpiredSessionCookies())

      request.log.info(
        {
          event: 'security.account.deleted',
          githubUserId: session.githubUserId,
          sessionId: session.id,
        },
        'Deleted local Shipgate account',
      )

      return reply.code(204).send(null)
    },
  )
}

function requireSession<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new ApiHttpError({
      statusCode: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: 'A valid Shipgate session is required',
    })
  }

  return value
}

async function reconcileSessionInstallations(
  context: ApplicationContext,
  session: AuthenticatedSession,
): Promise<void> {
  const userClient = await context.githubAuth.getUserClient(session.githubUserId)

  await context.githubRepositoryAccess.reconcileUserInstallations({
    githubUserId: session.githubUserId,
    userClient,
    installations: session.user.installations,
  })
}
