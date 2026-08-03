import { migrateToLatest } from '@shipgate/database'
import type {
  AppGitHubClient,
  GitHubAuthenticationService,
  GitHubResponse,
  InstallationGitHubClient,
  UserGitHubClient,
} from '@shipgate/github'
import {
  createTestEnvironment,
  type PostgresTestDatabase,
  startPostgresTestDatabase,
} from '@shipgate/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type ApplicationContext, createApplicationContext } from '../src/application-context.js'
import type { GitHubInstallationSummary } from '../src/auth/model.js'
import { createGitHubRepositoryAccessService } from '../src/github-access/index.js'
import { replaceGitHubInstallationSnapshot } from '../src/github-access/store.js'

describe.sequential('GitHub installation and repository access', () => {
  let postgres: PostgresTestDatabase
  let context: ApplicationContext

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    context = createApplicationContext({
      processKind: 'api',
      environment: createTestEnvironment(postgres.connectionString),
    })

    await migrateToLatest(context.database.kysely)

    await context.database.kysely
      .insertInto('github_user_credentials')
      .values({
        github_user_id: '99',
        encrypted_access_token: 'test-access-token',
        access_token_expires_at: new Date('2026-08-02T12:00:00.000Z'),
        encrypted_refresh_token: 'test-refresh-token',
        refresh_token_expires_at: new Date('2026-09-01T12:00:00.000Z'),
        refresh_lease_id: null,
        refresh_lease_expires_at: null,
      })
      .execute()
  }, 60_000)

  afterAll(async () => {
    await context.database.destroy()
    await postgres.stop()
  })

  it('reconciles repository access and invalidates stale cache', async () => {
    let now = new Date('2026-08-01T12:00:00.000Z')
    let repositoryPermission: 'read' | 'write' = 'read'
    let contentsPermission: 'read' | 'write' = 'write'
    let rejectUserRepositories = false
    let userRepositoryRequests = 0
    const invalidateInstallation = vi.fn()
    const invalidateUser = vi.fn()
    const githubAuth = createFakeGitHubAuthentication({
      get repositoryPermission() {
        return repositoryPermission
      },
      get contentsPermission() {
        return contentsPermission
      },
      get rejectUserRepositories() {
        return rejectUserRepositories
      },
      onUserRepositoryRequest() {
        userRepositoryRequests += 1
      },
      invalidateInstallation,
      invalidateUser,
    })
    expect(() =>
      createGitHubRepositoryAccessService({
        database: context.database,
        githubAuth,
        cacheTtlMs: 5 * 60_000 + 1,
      }),
    ).toThrow(RangeError)

    const service = createGitHubRepositoryAccessService({
      database: context.database,
      githubAuth,
      cacheTtlMs: 5 * 60_000,
      now: () => new Date(now),
    })
    const userClient = await githubAuth.getUserClient(99)
    const installations = await service.reconcileUserInstallations({
      githubUserId: 99,
      userClient,
      installations: [createInstallationSummary()],
    })

    expect(installations).toHaveLength(1)
    expect(userRepositoryRequests).toBe(1)

    const installationRow = await context.database.kysely
      .selectFrom('github_installations')
      .selectAll()
      .where('installation_id', '=', '123')
      .executeTakeFirstOrThrow()
    const repositoryRows = await context.database.kysely
      .selectFrom('github_installation_repositories')
      .select(['repository_id', 'full_name'])
      .where('installation_id', '=', '123')
      .orderBy('repository_id')
      .execute()
    const permissionRows = await context.database.kysely
      .selectFrom('github_installation_permissions')
      .select(['permission_name', 'permission_level'])
      .where('installation_id', '=', '123')
      .orderBy('permission_name')
      .execute()

    expect(installationRow).toMatchObject({
      owner_id: '99',
      owner_type: 'User',
      owner_login: 'octocat',
      repository_selection: 'selected',
      permission_state: 'current',
    })
    expect(repositoryRows).toEqual([
      {
        repository_id: '456',
        full_name: 'octocat/shipgate',
      },
      {
        repository_id: '789',
        full_name: 'octocat/private-release',
      },
    ])
    expect(permissionRows).toEqual([
      {
        permission_name: 'contents',
        permission_level: 'write',
      },
      {
        permission_name: 'metadata',
        permission_level: 'read',
      },
    ])

    const readAccess = await service.authorizeRepositoryAccess({
      githubUserId: 99,
      installationId: 123,
      repositoryId: 456,
      requiredPermission: {
        repository: 'read',
        app: {
          name: 'contents',
          level: 'write',
        },
      },
    })
    const inaccessibleRepository = await service.authorizeRepositoryAccess({
      githubUserId: 99,
      installationId: 123,
      repositoryId: 789,
      requiredPermission: {
        repository: 'read',
      },
    })
    const writeAccess = await service.authorizeRepositoryAccess({
      githubUserId: 99,
      installationId: 123,
      repositoryId: 456,
      requiredPermission: {
        repository: 'write',
      },
    })

    expect(readAccess).toMatchObject({
      allowed: true,
      reason: 'allowed',
      repositoryPermission: 'read',
    })
    expect(inaccessibleRepository).toMatchObject({
      allowed: false,
      reason: 'repository_not_accessible',
    })
    expect(writeAccess).toMatchObject({
      allowed: false,
      reason: 'insufficient_repository_permission',
    })
    expect(userRepositoryRequests).toBe(1)

    repositoryPermission = 'write'
    now = new Date(now.getTime() + 5 * 60_000 + 1)

    const refreshedWriteAccess = await service.authorizeRepositoryAccess({
      githubUserId: 99,
      installationId: 123,
      repositoryId: 456,
      requiredPermission: {
        repository: 'write',
      },
    })

    expect(refreshedWriteAccess).toMatchObject({
      allowed: true,
      repositoryPermission: 'write',
    })
    expect(userRepositoryRequests).toBe(2)

    contentsPermission = 'read'
    now = new Date(now.getTime() + 5 * 60_000 + 1)

    const insufficientAppPermission = await service.authorizeRepositoryAccess({
      githubUserId: 99,
      installationId: 123,
      repositoryId: 456,
      requiredPermission: {
        repository: 'read',
        app: {
          name: 'contents',
          level: 'write',
        },
      },
    })

    expect(insufficientAppPermission).toMatchObject({
      allowed: false,
      reason: 'insufficient_app_permission',
    })

    contentsPermission = 'write'
    rejectUserRepositories = true
    now = new Date(now.getTime() + 5 * 60_000 + 1)

    await expect(
      service.authorizeRepositoryAccess({
        githubUserId: 99,
        installationId: 123,
        repositoryId: 456,
        requiredPermission: {
          repository: 'read',
        },
      }),
    ).rejects.toMatchObject({
      name: 'GitHubRepositoryAccessVerificationError',
      status: 403,
    })

    expect(invalidateInstallation).toHaveBeenCalledWith(123)

    const staleInstallation = await context.database.kysely
      .selectFrom('github_installations')
      .select('permission_state')
      .where('installation_id', '=', '123')
      .executeTakeFirstOrThrow()

    expect(staleInstallation.permission_state).toBe('stale')

    rejectUserRepositories = false

    const recovered = await service.authorizeRepositoryAccess({
      githubUserId: 99,
      installationId: 123,
      repositoryId: 456,
      requiredPermission: {
        repository: 'read',
      },
    })

    expect(recovered.allowed).toBe(true)
    expect(userRepositoryRequests).toBe(5)
  })

  it('returns only installations still accessible to the user token', async () => {
    let userRepositoryRequests = 0
    const githubAuth = createFakeGitHubAuthentication({
      repositoryPermission: 'read',
      contentsPermission: 'write',
      rejectUserRepositories: false,
      inaccessibleInstallationIds: new Set([124]),
      onUserRepositoryRequest() {
        userRepositoryRequests += 1
      },
      invalidateInstallation: vi.fn(),
      invalidateUser: vi.fn(),
    })
    const service = createGitHubRepositoryAccessService({
      database: context.database,
      githubAuth,
    })
    const userClient = await githubAuth.getUserClient(99)
    const installations = await service.reconcileUserInstallations({
      githubUserId: 99,
      userClient,
      installations: [createInstallationSummary(123), createInstallationSummary(124)],
    })

    expect(installations.map((installation) => installation.id)).toEqual([123])
    expect(userRepositoryRequests).toBe(2)

    const inaccessibleInstallation = await context.database.kysely
      .selectFrom('github_installations')
      .select(['installation_id', 'permission_state'])
      .where('installation_id', '=', '124')
      .executeTakeFirstOrThrow()

    expect(inaccessibleInstallation).toEqual({
      installation_id: '124',
      permission_state: 'current',
    })
  })

  it('does not resurrect access cached before a concurrent invalidation', async () => {
    const metadataStarted = createDeferred<void>()
    const releaseMetadata = createDeferred<void>()
    let delayMetadata = true
    let userRepositoryRequests = 0
    const baseAuthentication = createFakeGitHubAuthentication({
      repositoryPermission: 'read',
      contentsPermission: 'write',
      rejectUserRepositories: false,
      onUserRepositoryRequest() {
        userRepositoryRequests += 1
      },
      invalidateInstallation: vi.fn(),
      invalidateUser: vi.fn(),
    })
    const appClient = await baseAuthentication.getAppClient()
    const githubAuth: GitHubAuthenticationService = {
      ...baseAuthentication,
      async getAppClient() {
        return {
          ...appClient,
          async request<Data = unknown>(
            route: string,
            parameters?: Readonly<Record<string, unknown>>,
          ): Promise<GitHubResponse<Data>> {
            if (route === 'GET /app/installations/{installation_id}' && delayMetadata) {
              delayMetadata = false
              metadataStarted.resolve()
              await releaseMetadata.promise
            }

            return appClient.request<Data>(route, parameters)
          },
        }
      },
    }
    const service = createGitHubRepositoryAccessService({
      database: context.database,
      githubAuth,
    })
    const pending = service.authorizeRepositoryAccess({
      githubUserId: 99,
      installationId: 125,
      repositoryId: 456,
      requiredPermission: {
        repository: 'read',
      },
    })

    await metadataStarted.promise
    service.invalidateInstallation(125)
    releaseMetadata.resolve()

    await expect(pending).rejects.toThrow('invalidated during reconciliation')
    expect(userRepositoryRequests).toBe(0)

    const recovered = await service.authorizeRepositoryAccess({
      githubUserId: 99,
      installationId: 125,
      repositoryId: 456,
      requiredPermission: {
        repository: 'read',
      },
    })

    expect(recovered.allowed).toBe(true)
    expect(userRepositoryRequests).toBe(1)
  })

  it('does not serve cached access after the user authorization is revoked', async () => {
    const githubAuth = createFakeGitHubAuthentication({
      repositoryPermission: 'read',
      contentsPermission: 'write',
      rejectUserRepositories: false,
      onUserRepositoryRequest() {},
      invalidateInstallation: vi.fn(),
      invalidateUser: vi.fn(),
    })
    const service = createGitHubRepositoryAccessService({
      database: context.database,
      githubAuth,
    })
    const allowed = await service.authorizeRepositoryAccess({
      githubUserId: 99,
      installationId: 126,
      repositoryId: 456,
      requiredPermission: { repository: 'read' },
    })
    expect(allowed.allowed).toBe(true)

    await context.database.kysely
      .deleteFrom('github_user_credentials')
      .where('github_user_id', '=', '99')
      .execute()

    const revoked = await service.authorizeRepositoryAccess({
      githubUserId: 99,
      installationId: 126,
      repositoryId: 456,
      requiredPermission: { repository: 'read' },
    })
    expect(revoked).toMatchObject({
      allowed: false,
      reason: 'installation_not_accessible',
    })
  })

  it('does not overwrite a newer lifecycle update with a stale access snapshot', async () => {
    const installationId = 127
    const lifecycleUpdatedAt = new Date('2026-08-03T12:05:00.000Z')

    await context.database.kysely
      .insertInto('github_installations')
      .values({
        installation_id: String(installationId),
        owner_id: '99',
        owner_type: 'User',
        owner_login: 'octocat',
        owner_avatar_url: null,
        repository_selection: 'selected',
        suspended_at: lifecycleUpdatedAt,
        permission_state: 'suspended',
        lifecycle_state: 'suspended',
        deletion_requested_at: null,
        deleted_at: null,
        last_successful_confirmation_at: lifecycleUpdatedAt,
        last_reconciled_at: lifecycleUpdatedAt,
        updated_at: lifecycleUpdatedAt,
      })
      .execute()

    await expect(
      replaceGitHubInstallationSnapshot(context.database, {
        installation: {
          summary: createInstallationSummary(installationId),
          permissions: { metadata: 'read', contents: 'write' },
        },
        repositories: [],
        userRepositories: [],
        reconciledAt: new Date('2026-08-03T12:00:00.000Z'),
      }),
    ).rejects.toThrow('changed while its access snapshot was being reconciled')

    const installation = await context.database.kysely
      .selectFrom('github_installations')
      .select(['lifecycle_state', 'permission_state', 'last_reconciled_at'])
      .where('installation_id', '=', String(installationId))
      .executeTakeFirstOrThrow()

    expect(installation).toEqual({
      lifecycle_state: 'suspended',
      permission_state: 'suspended',
      last_reconciled_at: lifecycleUpdatedAt,
    })
  })

  it('never resurrects an installation pending deletion from a later snapshot', async () => {
    const installationId = 128
    const deletionRequestedAt = new Date('2026-08-03T12:00:00.000Z')

    await context.database.kysely
      .insertInto('github_installations')
      .values({
        installation_id: String(installationId),
        owner_id: '99',
        owner_type: 'User',
        owner_login: 'octocat',
        owner_avatar_url: null,
        repository_selection: 'selected',
        suspended_at: null,
        permission_state: 'revoked',
        lifecycle_state: 'pending_deletion',
        deletion_requested_at: deletionRequestedAt,
        deleted_at: null,
        last_successful_confirmation_at: deletionRequestedAt,
        last_reconciled_at: deletionRequestedAt,
        updated_at: deletionRequestedAt,
      })
      .execute()

    await expect(
      replaceGitHubInstallationSnapshot(context.database, {
        installation: {
          summary: createInstallationSummary(installationId),
          permissions: { metadata: 'read', contents: 'write' },
        },
        repositories: [],
        userRepositories: [],
        reconciledAt: new Date('2026-08-03T12:10:00.000Z'),
      }),
    ).rejects.toThrow('changed while its access snapshot was being reconciled')

    const installation = await context.database.kysely
      .selectFrom('github_installations')
      .select(['lifecycle_state', 'permission_state', 'deletion_requested_at'])
      .where('installation_id', '=', String(installationId))
      .executeTakeFirstOrThrow()

    expect(installation).toEqual({
      lifecycle_state: 'pending_deletion',
      permission_state: 'revoked',
      deletion_requested_at: deletionRequestedAt,
    })
  })
})

function createDeferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return {
    promise,
    resolve,
    reject,
  }
}

interface FakeGitHubState {
  readonly repositoryPermission: 'read' | 'write'
  readonly contentsPermission: 'read' | 'write'
  readonly rejectUserRepositories: boolean
  readonly inaccessibleInstallationIds?: ReadonlySet<number>
  readonly onUserRepositoryRequest: () => void
  readonly invalidateInstallation: (installationId: number) => void
  readonly invalidateUser: (githubUserId: number) => void
}

function createFakeGitHubAuthentication(state: FakeGitHubState): GitHubAuthenticationService {
  const appClient = createAppClient(state)
  const userClient = createUserClient(state)

  return {
    async getAppClient() {
      return appClient
    },
    async getInstallationClient(input) {
      return createInstallationClient(input.installationId)
    },
    async getUserClient() {
      return userClient
    },
    async authorizeUser() {
      throw new Error('Not used')
    },
    invalidateInstallation: state.invalidateInstallation,
    invalidateUser: state.invalidateUser,
    async revokeUser() {},
    async disconnectUser() {},
  }
}

function createAppClient(state: FakeGitHubState): AppGitHubClient {
  return {
    authentication: {
      type: 'app',
      appId: 123_456,
    },
    async request<Data = unknown>(
      route: string,
      parameters?: Readonly<Record<string, unknown>>,
    ): Promise<GitHubResponse<Data>> {
      if (route === 'GET /app/installations/{installation_id}') {
        const installationId = getRequestedInstallationId(parameters)

        return createResponse<Data>({
          id: installationId,
          account: {
            id: 99,
            login: 'octocat',
            type: 'User',
            avatar_url: 'https://avatars.example/octocat.png',
          },
          target_type: 'User',
          repository_selection: 'selected',
          permissions: {
            metadata: 'read',
            contents: state.contentsPermission,
          },
          suspended_at: null,
        })
      }

      return createResponse<Data>({})
    },
    async graphql<Data = unknown>() {
      return {} as Data
    },
  }
}

function createInstallationClient(installationId: number): InstallationGitHubClient {
  return {
    authentication: {
      type: 'installation',
      installationId,
      repositoryIds: undefined,
      permissions: {
        metadata: 'read',
      },
    },
    async request<Data = unknown>(route: string): Promise<GitHubResponse<Data>> {
      if (route === 'GET /installation/repositories') {
        return createResponse<Data>({
          total_count: 2,
          repositories: [
            createRepository(456, 'shipgate', { pull: true, push: true }),
            createRepository(789, 'private-release', { pull: true, push: true }),
          ],
        })
      }

      return createResponse<Data>({})
    },
    async graphql<Data = unknown>() {
      return {} as Data
    },
  }
}

function createUserClient(state: FakeGitHubState): UserGitHubClient {
  return {
    authentication: {
      type: 'user',
      userId: 99,
    },
    async request<Data = unknown>(
      route: string,
      parameters?: Readonly<Record<string, unknown>>,
    ): Promise<GitHubResponse<Data>> {
      if (route === 'GET /user/installations/{installation_id}/repositories') {
        state.onUserRepositoryRequest()
        const installationId = getRequestedInstallationId(parameters)

        if (state.inaccessibleInstallationIds?.has(installationId)) {
          throw Object.assign(new Error('Not Found'), {
            status: 404,
          })
        }

        if (state.rejectUserRepositories) {
          throw Object.assign(new Error('Forbidden'), {
            status: 403,
          })
        }

        return createResponse<Data>({
          total_count: 1,
          repositories: [
            createRepository(456, 'shipgate', {
              pull: true,
              push: state.repositoryPermission === 'write',
            }),
          ],
        })
      }

      return createResponse<Data>({})
    },
    async graphql<Data = unknown>() {
      return {} as Data
    },
  }
}

function createInstallationSummary(id = 123): GitHubInstallationSummary {
  return {
    id,
    account: {
      id: 99,
      login: 'octocat',
      type: 'User',
      avatarUrl: 'https://avatars.example/octocat.png',
    },
    repositorySelection: 'selected',
    permissions: {
      metadata: 'read',
      contents: 'write',
    },
    suspendedAt: null,
  }
}

function createRepository(
  id: number,
  name: string,
  permissions: Readonly<Record<string, boolean>>,
) {
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
    permissions,
  }
}

function getRequestedInstallationId(
  parameters: Readonly<Record<string, unknown>> | undefined,
): number {
  const installationId = parameters?.installation_id

  if (typeof installationId !== 'number' || !Number.isSafeInteger(installationId)) {
    throw new Error('Expected a numeric installation_id parameter')
  }

  return installationId
}

function createResponse<Data>(data: unknown): GitHubResponse<Data> {
  return {
    data: data as Data,
    status: 200,
    headers: {},
    url: 'https://api.github.com/test',
  }
}
