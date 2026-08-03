import { createHmac, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { migrateToLatest } from '@shipgate/database'
import {
  GITHUB_APP_REPOSITORY_PERMISSIONS,
  type AppGitHubClient,
  type GitHubAuthenticationService,
  type GitHubResponse,
  type InstallationGitHubClient,
  type UserGitHubClient,
} from '@shipgate/github'
import {
  enqueueJob,
  type JobWorkerRuntime,
  migrateJobQueue,
  startJobWorker,
  waitForJobExecution,
} from '@shipgate/jobs'
import {
  createTestEnvironment,
  type PostgresTestDatabase,
  startPostgresTestDatabase,
} from '@shipgate/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type ApplicationContext, createApplicationContext } from '../src/application-context.js'
import { createGitHubRepositoryAccessService } from '../src/github-access/index.js'
import { buildApiApplication } from '../src/http/api-app.js'

const webhookSecret = 'test-webhook-secret'
const installationId = 123
const repositoryId = 456

describe.sequential('GitHub connection UI integration contract', () => {
  let postgres: PostgresTestDatabase
  let baseContext: ApplicationContext
  let context: ApplicationContext
  let app: FastifyInstance
  let worker: JobWorkerRuntime
  let authState: FakeGitHubState
  let session: LoginSession

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    baseContext = createApplicationContext({
      processKind: 'api',
      environment: createTestEnvironment(postgres.connectionString, {
        APP_ORIGIN: 'https://shipgate.example',
        GITHUB_APP_ID: '123456',
        GITHUB_APP_CLIENT_ID: 'Iv1.shipgate',
        GITHUB_APP_SLUG: 'shipgate-release',
        GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
      }),
    })

    await migrateJobQueue(baseContext.database)
    await migrateToLatest(baseContext.database.kysely)

    authState = {
      hasInstallation: true,
      userHasRepository: true,
    }
    const githubAuth = createFakeGitHubAuthentication(baseContext, authState)
    context = {
      ...baseContext,
      githubAuth,
      githubRepositoryAccess: createGitHubRepositoryAccessService({
        database: baseContext.database,
        githubAuth,
      }),
    }
    worker = await startWorker(context)
    app = await buildApiApplication(context)
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app.close()
    await worker.stop()
    await baseContext.database.destroy()
    await postgres.stop()
  })

  it('shows setup when the GitHub App is not installed and revokes a normal session', async () => {
    authState.hasInstallation = false
    const emptySession = await login(app)
    const installations = await authenticatedGet(app, emptySession, '/api/v1/installations')

    expect(installations.json()).toEqual({ installations: [] })

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: emptySession.cookieHeader,
        'content-type': 'application/json',
        'x-csrf-token': emptySession.csrfToken,
      },
      payload: {},
    })
    expect(logout.statusCode).toBe(204)

    const revokedSession = await authenticatedGet(app, emptySession, '/api/v1/auth/session')
    expect(revokedSession.json()).toEqual({ authenticated: false })
    authState.hasInstallation = true
  })

  it('completes OAuth and exposes installations and the App/user repository intersection', async () => {
    session = await login(app)

    const configuration = await app.inject({
      method: 'GET',
      url: '/api/v1/connection',
    })
    expect(configuration.json()).toEqual({
      githubLoginConfigured: true,
      githubInstallationConfigured: true,
      loginUrl: '/api/v1/auth/github?returnTo=%2Fsetup',
      installUrl: 'https://github.com/apps/shipgate-release/installations/new',
    })

    const installations = await authenticatedGet(app, session, '/api/v1/installations')
    expect(installations.json()).toMatchObject({
      installations: [
        {
          id: installationId,
          owner: { login: 'octocat' },
          repositoryCount: 1,
          userRepositoryCount: 1,
        },
      ],
    })

    const detail = await authenticatedGet(app, session, `/api/v1/installations/${installationId}`)
    expect(detail.json()).toMatchObject({
      id: installationId,
      permissionUpgradePending: false,
      repositories: [
        {
          id: repositoryId,
          fullName: 'octocat/shipgate',
          userPermission: 'write',
          accessibleToUser: true,
        },
      ],
    })
  })

  it('rebuilds a missing connection read model from the authenticated session', async () => {
    await context.database.kysely
      .deleteFrom('github_user_installations')
      .where('github_user_id', '=', '99')
      .execute()

    const installations = await authenticatedGet(app, session, '/api/v1/installations')

    expect(installations.json()).toMatchObject({
      installations: [
        {
          id: installationId,
          repositoryCount: 1,
          userRepositoryCount: 1,
        },
      ],
    })
  })

  it('rejects invalid signatures and deduplicates delivery IDs', async () => {
    const deliveryId = randomUUID()
    const payload = { zen: 'Keep it logically awesome.' }

    const invalid = await sendWebhook(app, 'ping', deliveryId, payload, 'invalid-signature')
    expect(invalid.statusCode).toBe(401)

    const accepted = await sendWebhook(app, 'ping', deliveryId, payload)
    expect(accepted.statusCode).toBe(202)

    const duplicate = await sendWebhook(app, 'ping', deliveryId, payload)
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json()).toMatchObject({ status: 'duplicate' })

    const conflict = await sendWebhook(app, 'ping', deliveryId, { zen: 'different' })
    expect(conflict.statusCode).toBe(409)

    await waitForDelivery(context, deliveryId, 'succeeded')
  })

  it('reflects create, permission upgrade, repository, suspend, and unsuspend lifecycle changes', async () => {
    const createdId = randomUUID()
    await expectAccepted(
      sendWebhook(app, 'installation', createdId, {
        action: 'created',
        installation: createInstallation({ permissions: { metadata: 'read' } }),
        repositories: [createRepository(repositoryId)],
      }),
    )
    await waitForDelivery(context, createdId, 'succeeded')

    let detail = await authenticatedGet(app, session, `/api/v1/installations/${installationId}`)
    expect(detail.json()).toMatchObject({
      permissionUpgradePending: true,
    })

    const acceptedId = randomUUID()
    await expectAccepted(
      sendWebhook(app, 'installation', acceptedId, {
        action: 'new_permissions_accepted',
        installation: createInstallation({ permissions: GITHUB_APP_REPOSITORY_PERMISSIONS }),
      }),
    )
    await waitForDelivery(context, acceptedId, 'succeeded')

    detail = await authenticatedGet(app, session, `/api/v1/installations/${installationId}`)
    expect(detail.json()).toMatchObject({ permissionUpgradePending: false })

    const addedRepositoryId = 789
    const addedId = randomUUID()
    await expectAccepted(
      sendWebhook(app, 'installation_repositories', addedId, {
        action: 'added',
        installation: createInstallation(),
        repositories_added: [createRepository(addedRepositoryId, 'private-release')],
        repositories_removed: [],
      }),
    )
    await waitForDelivery(context, addedId, 'succeeded')

    detail = await authenticatedGet(app, session, `/api/v1/installations/${installationId}`)
    expect(detail.json()).toMatchObject({
      repositoryCount: 2,
      repositories: expect.arrayContaining([
        expect.objectContaining({
          id: addedRepositoryId,
          accessibleToUser: false,
          userPermission: 'none',
        }),
      ]),
    })

    const removedId = randomUUID()
    await expectAccepted(
      sendWebhook(app, 'installation_repositories', removedId, {
        action: 'removed',
        installation: createInstallation(),
        repositories_added: [],
        repositories_removed: [createRepository(addedRepositoryId, 'private-release')],
      }),
    )
    await waitForDelivery(context, removedId, 'succeeded')

    detail = await authenticatedGet(app, session, `/api/v1/installations/${installationId}`)
    expect(detail.json()).toMatchObject({ repositoryCount: 1 })

    const suspendId = randomUUID()
    await expectAccepted(
      sendWebhook(app, 'installation', suspendId, {
        action: 'suspend',
        installation: createInstallation({ suspendedAt: '2026-08-03T16:00:00.000Z' }),
      }),
    )
    await waitForDelivery(context, suspendId, 'succeeded')

    detail = await authenticatedGet(app, session, `/api/v1/installations/${installationId}`)
    expect(detail.json()).toMatchObject({
      lifecycleState: 'suspended',
      permissionState: 'suspended',
    })

    const unsuspendId = randomUUID()
    await expectAccepted(
      sendWebhook(app, 'installation', unsuspendId, {
        action: 'unsuspend',
        installation: createInstallation(),
      }),
    )
    await waitForDelivery(context, unsuspendId, 'succeeded')

    detail = await authenticatedGet(app, session, `/api/v1/installations/${installationId}`)
    expect(detail.json()).toMatchObject({
      lifecycleState: 'active',
      permissionState: 'stale',
    })

    const reconciliationEvent = await context.database.kysely
      .selectFrom('github_integration_events')
      .select('event_type')
      .where('event_type', '=', 'github.installation.reconciliation_requested')
      .where('installation_id', '=', String(installationId))
      .executeTakeFirst()
    expect(reconciliationEvent).toBeDefined()
  })

  it('shows when the GitHub user loses repository access', async () => {
    authState.userHasRepository = false
    const userClient = await context.githubAuth.getUserClient(99)
    await context.githubRepositoryAccess.reconcileUserInstallations({
      githubUserId: 99,
      userClient,
      installations: [createInstallationSummary()],
    })

    const detail = await authenticatedGet(app, session, `/api/v1/installations/${installationId}`)
    expect(detail.json()).toMatchObject({
      repositoryCount: 1,
      userRepositoryCount: 0,
      repositories: [
        expect.objectContaining({
          id: repositoryId,
          userPermission: 'none',
          accessibleToUser: false,
        }),
      ],
    })

    authState.userHasRepository = true
    await context.githubRepositoryAccess.reconcileUserInstallations({
      githubUserId: 99,
      userClient,
      installations: [createInstallationSummary()],
    })
  })

  it('deletes the local account separately from a normal session logout', async () => {
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: {
        cookie: session.cookieHeader,
        'x-csrf-token': session.csrfToken,
      },
    })
    expect(deleted.statusCode).toBe(204)

    const user = await context.database.kysely
      .selectFrom('github_users')
      .select('github_user_id')
      .where('github_user_id', '=', '99')
      .executeTakeFirst()
    expect(user).toBeUndefined()

    const afterDelete = await authenticatedGet(app, session, '/api/v1/auth/session')
    expect(afterDelete.json()).toEqual({ authenticated: false })

    session = await login(app)
  })

  it('recovers a delivery left processing by a crashed worker', async () => {
    await worker.stop()

    const deliveryId = randomUUID()
    await expectAccepted(
      sendWebhook(app, 'repository', deliveryId, {
        action: 'renamed',
        installation: createInstallation(),
        repository: createRepository(repositoryId, 'shipgate-renamed'),
      }),
    )

    await context.database.kysely
      .updateTable('github_webhook_deliveries')
      .set({
        processing_state: 'processing',
        processing_started_at: new Date(),
        updated_at: new Date(),
      })
      .where('delivery_id', '=', deliveryId)
      .execute()

    worker = await startWorker(context)
    await waitForDelivery(context, deliveryId, 'succeeded')

    const repository = await context.database.kysely
      .selectFrom('github_installation_repositories')
      .select('name')
      .where('installation_id', '=', String(installationId))
      .where('repository_id', '=', String(repositoryId))
      .executeTakeFirstOrThrow()
    expect(repository.name).toBe('shipgate-renamed')
  })

  it('purges expired raw webhook payloads through the retention job', async () => {
    const deliveryId = randomUUID()
    await expectAccepted(sendWebhook(app, 'ping', deliveryId, { zen: 'retention' }))
    await waitForDelivery(context, deliveryId, 'succeeded')

    const expiredAt = new Date(Date.now() - 1_000)

    await context.database.kysely
      .updateTable('github_webhook_deliveries')
      .set({
        received_at: new Date(expiredAt.getTime() - 1_000),
        raw_payload_expires_at: expiredAt,
        raw_payload_purged_at: null,
        updated_at: new Date(),
      })
      .where('delivery_id', '=', deliveryId)
      .execute()

    const job = await enqueueJob(
      context.database,
      'github_webhook_retention_cleanup',
      {},
      {
        correlationId: randomUUID(),
        causationId: `test:${deliveryId}`,
      },
    )
    const execution = await waitForJobExecution(context.database, job.jobId, { timeoutMs: 20_000 })
    expect(execution.status).toBe('succeeded')

    const delivery = await context.database.kysely
      .selectFrom('github_webhook_deliveries')
      .select(['raw_payload', 'raw_payload_purged_at'])
      .where('delivery_id', '=', deliveryId)
      .executeTakeFirstOrThrow()
    expect(delivery.raw_payload).toBeNull()
    expect(delivery.raw_payload_purged_at).toBeInstanceOf(Date)
  })

  it('closes installation access and sessions after uninstall and authorization revoke', async () => {
    const deletedId = randomUUID()
    await expectAccepted(
      sendWebhook(app, 'installation', deletedId, {
        action: 'deleted',
        installation: createInstallation(),
      }),
    )
    await waitForDelivery(context, deletedId, 'succeeded')

    const detail = await authenticatedGet(app, session, `/api/v1/installations/${installationId}`)
    expect(detail.json()).toMatchObject({
      lifecycleState: 'pending_deletion',
      permissionState: 'revoked',
      repositoryCount: 0,
    })

    const revokedId = randomUUID()
    await expectAccepted(
      sendWebhook(app, 'github_app_authorization', revokedId, {
        action: 'revoked',
        sender: { id: 99, login: 'octocat' },
      }),
    )
    await waitForDelivery(context, revokedId, 'succeeded')

    const afterRevoke = await authenticatedGet(app, session, '/api/v1/auth/session')
    expect(afterRevoke.json()).toEqual({ authenticated: false })
  })
})

interface FakeGitHubState {
  hasInstallation: boolean
  userHasRepository: boolean
}

interface LoginSession {
  readonly cookieHeader: string
  readonly csrfToken: string
}

function createFakeGitHubAuthentication(
  context: ApplicationContext,
  state: FakeGitHubState,
): GitHubAuthenticationService {
  const userClient: UserGitHubClient = {
    authentication: { type: 'user', userId: 99 },
    async request<Data = unknown>(route: string): Promise<GitHubResponse<Data>> {
      if (route === 'GET /user') {
        return response<Data>({
          id: 99,
          login: 'octocat',
          avatar_url: 'https://avatars.example/octocat.png',
          name: 'The Octocat',
          email: null,
          html_url: 'https://github.com/octocat',
        })
      }

      if (route === 'GET /user/installations') {
        return response<Data>({
          total_count: state.hasInstallation ? 1 : 0,
          installations: state.hasInstallation ? [createInstallation()] : [],
        })
      }

      if (route === 'GET /user/installations/{installation_id}/repositories') {
        return response<Data>({
          total_count: state.userHasRepository ? 1 : 0,
          repositories: state.userHasRepository ? [createRepository(repositoryId)] : [],
        })
      }

      return response<Data>({})
    },
    async graphql<Data = unknown>() {
      return {} as Data
    },
  }
  const appClient: AppGitHubClient = {
    authentication: { type: 'app', appId: 123_456 },
    async request<Data = unknown>(route: string): Promise<GitHubResponse<Data>> {
      if (route === 'GET /app/installations/{installation_id}') {
        return response<Data>(createInstallation())
      }

      return response<Data>({})
    },
    async graphql<Data = unknown>() {
      return {} as Data
    },
  }
  const installationClient: InstallationGitHubClient = {
    authentication: {
      type: 'installation',
      installationId,
      repositoryIds: undefined,
      permissions: { metadata: 'read' },
    },
    async request<Data = unknown>(route: string): Promise<GitHubResponse<Data>> {
      if (route === 'GET /installation/repositories') {
        return response<Data>({
          total_count: 1,
          repositories: [createRepository(repositoryId)],
        })
      }

      return response<Data>({})
    },
    async graphql<Data = unknown>() {
      return {} as Data
    },
  }

  return {
    async getAppClient() {
      return appClient
    },
    async getInstallationClient() {
      return installationClient
    },
    async getUserClient() {
      return userClient
    },
    async authorizeUser() {
      await context.database.kysely
        .insertInto('github_user_credentials')
        .values({
          github_user_id: '99',
          encrypted_access_token: 'encrypted-access',
          access_token_expires_at: new Date(Date.now() + 60 * 60_000),
          encrypted_refresh_token: 'encrypted-refresh',
          refresh_token_expires_at: new Date(Date.now() + 24 * 60 * 60_000),
          refresh_lease_id: null,
          refresh_lease_expires_at: null,
        })
        .onConflict((conflict) =>
          conflict.column('github_user_id').doUpdateSet({
            encrypted_access_token: 'encrypted-access',
            access_token_expires_at: new Date(Date.now() + 60 * 60_000),
            encrypted_refresh_token: 'encrypted-refresh',
            refresh_token_expires_at: new Date(Date.now() + 24 * 60 * 60_000),
            refresh_lease_id: null,
            refresh_lease_expires_at: null,
          }),
        )
        .execute()

      return {
        userId: 99,
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000),
        refreshTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      }
    },
    invalidateInstallation() {},
    invalidateUser() {},
    async revokeUser(userId) {
      await context.database.kysely
        .deleteFrom('github_user_credentials')
        .where('github_user_id', '=', String(userId))
        .execute()
    },
    async disconnectUser(userId) {
      await context.database.kysely
        .deleteFrom('github_user_credentials')
        .where('github_user_id', '=', String(userId))
        .execute()
    },
  }
}

async function login(app: FastifyInstance): Promise<LoginSession> {
  const started = await app.inject({ method: 'GET', url: '/api/v1/auth/github?returnTo=%2Fsetup' })
  const authorizeUrl = new URL(requireHeader(started.headers.location, 'location'))
  const state = requireValue(authorizeUrl.searchParams.get('state'), 'state')
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/github/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
  })
  expect(callback.statusCode).toBe(302)
  expect(callback.headers.location).toContain('/setup?auth=succeeded')
  const cookies = readSetCookies(callback.headers['set-cookie'])

  return {
    cookieHeader: cookies.map((cookie) => cookie.split(';', 1)[0]).join('; '),
    csrfToken: readCookie(cookies, '__Host-shipgate_csrf'),
  }
}

async function authenticatedGet(app: FastifyInstance, loginSession: LoginSession, url: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: { cookie: loginSession.cookieHeader },
  })
}

async function sendWebhook(
  app: FastifyInstance,
  event: string,
  deliveryId: string,
  payload: unknown,
  signatureOverride?: string,
) {
  const rawBody = JSON.stringify(payload)
  const signature =
    signatureOverride ??
    `sha256=${createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`

  return app.inject({
    method: 'POST',
    url: '/api/v1/github/webhooks',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signature,
    },
    payload: rawBody,
  })
}

async function expectAccepted(responsePromise: ReturnType<typeof sendWebhook>): Promise<void> {
  const response = await responsePromise
  expect(response.statusCode).toBe(202)
}

async function waitForDelivery(
  context: ApplicationContext,
  deliveryId: string,
  state: 'succeeded' | 'failed',
): Promise<void> {
  const deadline = Date.now() + 20_000

  while (Date.now() < deadline) {
    const delivery = await context.database.kysely
      .selectFrom('github_webhook_deliveries')
      .select('processing_state')
      .where('delivery_id', '=', deliveryId)
      .executeTakeFirst()

    if (delivery?.processing_state === state) {
      return
    }

    await delay(50)
  }

  throw new Error(`Webhook delivery ${deliveryId} did not reach ${state}`)
}

async function startWorker(context: ApplicationContext): Promise<JobWorkerRuntime> {
  return startJobWorker({
    dependencies: {
      database: context.database,
      logger: context.logger,
    },
    appVersion: 'test',
    concurrency: 1,
    pollIntervalMs: 100,
    heartbeatIntervalMs: 1_000,
    shutdownAbortTimeoutMs: 3_000,
  })
}

function createInstallation(
  input: {
    readonly permissions?: Readonly<Record<string, 'read' | 'write'>>
    readonly suspendedAt?: string | null
  } = {},
) {
  return {
    id: installationId,
    account: {
      id: 99,
      login: 'octocat',
      type: 'User',
      avatar_url: 'https://avatars.example/octocat.png',
    },
    target_type: 'User',
    repository_selection: 'selected',
    permissions: input.permissions ?? GITHUB_APP_REPOSITORY_PERMISSIONS,
    suspended_at: input.suspendedAt ?? null,
  }
}

function createInstallationSummary() {
  return {
    id: installationId,
    account: {
      id: 99,
      login: 'octocat',
      type: 'User',
      avatarUrl: 'https://avatars.example/octocat.png',
    },
    repositorySelection: 'selected' as const,
    permissions: GITHUB_APP_REPOSITORY_PERMISSIONS,
    suspendedAt: null,
  }
}

function createRepository(id: number, name = 'shipgate') {
  return {
    id,
    name,
    full_name: `octocat/${name}`,
    private: true,
    archived: false,
    disabled: false,
    default_branch: 'main',
    visibility: 'private',
    owner: {
      id: 99,
      login: 'octocat',
    },
    permissions: {
      pull: true,
      push: true,
    },
  }
}

function response<Data>(data: unknown): GitHubResponse<Data> {
  return {
    data: data as Data,
    status: 200,
    headers: {},
    url: 'https://api.github.test/fixture',
  }
}

function readSetCookies(value: string | string[] | undefined): readonly string[] {
  if (!value) return []
  return Array.isArray(value) ? value : value.split(/,(?=\s*__Host-)/)
}

function readCookie(cookies: readonly string[], name: string): string {
  const prefix = `${name}=`
  const cookie = cookies.find((value) => value.startsWith(prefix))
  if (!cookie) throw new Error(`Missing cookie ${name}`)
  return decodeURIComponent(cookie.slice(prefix.length).split(';', 1)[0] ?? '')
}

function requireHeader(value: string | string[] | undefined, name: string): string {
  const resolved = Array.isArray(value) ? value[0] : value
  if (!resolved) throw new Error(`Missing ${name} header`)
  return resolved
}

function requireValue<Value>(value: Value | null | undefined, name: string): Value {
  if (value == null) throw new Error(`Missing ${name}`)
  return value
}
