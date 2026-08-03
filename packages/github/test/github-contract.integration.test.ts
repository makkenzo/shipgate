import { generateKeyPairSync } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  createAes256GcmGitHubTokenCipher,
  createGitHubAuthenticationService,
  type GitHubAuthenticationService,
} from '@shipgate/github'
import { createInMemoryGitHubUserTokenStore } from '@shipgate/github/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createGitHubClient } from '../src/client.js'
import {
  createOAuthTokenFixture,
  githubRepositoryFixture,
  githubUserFixture,
} from './fixtures/github-contract.js'

interface MockState {
  tokenSequence: number
  authorizationExchanges: number
  lastAuthorizationExchange: Readonly<Record<string, string>> | null
  refreshes: number
  installationTokenRequests: readonly Record<string, unknown>[]
  rateLimitRequests: number
  revokeRefreshToken: boolean
}

describe.sequential('GitHub HTTP contracts', () => {
  let origin: string
  let closeServer: () => Promise<void>
  let state: MockState

  beforeAll(async () => {
    state = createState()
    const started = await startMockGitHubServer(state)
    origin = started.origin
    closeServer = started.close
  })

  afterAll(async () => {
    await closeServer()
  })

  it('completes OAuth and rotates one refresh token across concurrent providers', async () => {
    const now = { value: new Date('2026-08-03T12:00:00.000Z') }
    const store = createInMemoryGitHubUserTokenStore()
    const cipher = createAes256GcmGitHubTokenCipher({
      key: Buffer.alloc(32, 7).toString('base64url'),
    })
    const first = createAuthenticationService({ origin, store, cipher, now: () => now.value })

    const authorization = await first.authorizeUser({
      code: 'contract-authorization-code',
      codeVerifier: 'v'.repeat(64),
    })

    expect(authorization.userId).toBe(99)
    expect(state.authorizationExchanges).toBe(1)
    expect(state.lastAuthorizationExchange).toMatchObject({
      code: 'contract-authorization-code',
      code_verifier: 'v'.repeat(64),
    })

    now.value = new Date(now.value.getTime() + 56_000)
    const second = createAuthenticationService({ origin, store, cipher, now: () => now.value })

    const [firstClient, secondClient] = await Promise.all([
      first.getUserClient(99),
      second.getUserClient(99),
    ])

    expect(firstClient.authentication).toEqual({ type: 'user', userId: 99 })
    expect(secondClient.authentication).toEqual({ type: 'user', userId: 99 })
    expect(state.refreshes).toBe(1)
    expect((await store.get(99))?.version).toBe(2)
  })

  it('removes a revoked authorization after GitHub rejects its refresh token', async () => {
    const now = { value: new Date('2026-08-03T13:00:00.000Z') }
    const store = createInMemoryGitHubUserTokenStore()
    const cipher = createAes256GcmGitHubTokenCipher({
      key: Buffer.alloc(32, 8).toString('base64url'),
    })
    const service = createAuthenticationService({ origin, store, cipher, now: () => now.value })

    await service.authorizeUser({ code: 'revoked-authorization', codeVerifier: 'r'.repeat(64) })
    now.value = new Date(now.value.getTime() + 56_000)
    state.revokeRefreshToken = true

    await expect(service.getUserClient(99)).rejects.toMatchObject({
      name: 'GitHubUserReauthorizationRequiredError',
      userId: 99,
    })
    expect(await store.get(99)).toBeUndefined()

    state.revokeRefreshToken = false
  })

  it('serves installation and user repository contracts through real clients', async () => {
    const store = createInMemoryGitHubUserTokenStore()
    const cipher = createAes256GcmGitHubTokenCipher({
      key: Buffer.alloc(32, 10).toString('base64url'),
    })
    const service = createAuthenticationService({
      origin,
      store,
      cipher,
      now: () => new Date('2026-08-03T14:00:00.000Z'),
    })

    await service.authorizeUser({ code: 'repository-contract', codeVerifier: 'c'.repeat(64) })
    const userClient = await service.getUserClient(99)
    const userInstallations = await userClient.request('GET /user/installations')
    const userRepositories = await userClient.request(
      'GET /user/installations/{installation_id}/repositories',
      { installation_id: 123 },
    )
    const installationClient = await service.getInstallationClient({
      installationId: 123,
      repositoryIds: [githubRepositoryFixture.id],
      permissions: { metadata: 'read' },
    })
    const installationRepositories = await installationClient.request(
      'GET /installation/repositories',
    )

    expect(userInstallations.data).toMatchObject({
      total_count: 1,
      installations: [expect.objectContaining({ id: 123 })],
    })
    expect(userRepositories.data).toMatchObject({
      total_count: 1,
      repositories: [expect.objectContaining({ id: githubRepositoryFixture.id })],
    })
    expect(installationRepositories.data).toMatchObject({
      total_count: 1,
      repositories: [expect.objectContaining({ id: githubRepositoryFixture.id })],
    })
  })

  it('requests an installation token restricted to repositories and permissions', async () => {
    const store = createInMemoryGitHubUserTokenStore()
    const cipher = createAes256GcmGitHubTokenCipher({
      key: Buffer.alloc(32, 9).toString('base64url'),
    })
    const service = createAuthenticationService({
      origin,
      store,
      cipher,
      now: () => new Date('2026-08-03T14:00:00.000Z'),
    })

    const client = await service.getInstallationClient({
      installationId: 123,
      repositoryIds: [789, 456, 456],
      permissions: {
        metadata: 'read',
        contents: 'write',
      },
    })

    expect(client.authentication).toEqual({
      type: 'installation',
      installationId: 123,
      repositoryIds: [456, 789],
      permissions: {
        metadata: 'read',
        contents: 'write',
      },
    })
    expect(state.installationTokenRequests.at(-1)).toEqual({
      repository_ids: [456, 789],
      permissions: {
        metadata: 'read',
        contents: 'write',
      },
    })
  })

  it('surfaces Retry-After and does not loop on a GitHub rate limit', async () => {
    const client = createGitHubClient({
      auth: 'rate-limit-token',
      authentication: { type: 'user', userId: 99 },
      apiBaseUrl: origin,
      apiVersion: '2026-03-10',
      requestTimeoutMs: 1_000,
      userAgent: 'shipgate-contract-test',
      onUnauthorized() {},
    })

    await expect(client.request('GET /rate-limit')).rejects.toMatchObject({
      status: 403,
      response: {
        headers: {
          'retry-after': '7',
          'x-ratelimit-remaining': '0',
        },
      },
    })
    expect(state.rateLimitRequests).toBe(1)
  })
})

function createState(): MockState {
  return {
    tokenSequence: 0,
    authorizationExchanges: 0,
    lastAuthorizationExchange: null,
    refreshes: 0,
    installationTokenRequests: [],
    rateLimitRequests: 0,
    revokeRefreshToken: false,
  }
}

function createAuthenticationService(input: {
  readonly origin: string
  readonly store: ReturnType<typeof createInMemoryGitHubUserTokenStore>
  readonly cipher: ReturnType<typeof createAes256GcmGitHubTokenCipher>
  readonly now: () => Date
}): GitHubAuthenticationService {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
  })

  return createGitHubAuthenticationService({
    appId: 123_456,
    clientId: 'Iv1.shipgate-contract',
    clientSecret: 'contract-client-secret',
    privateKey,
    apiBaseUrl: input.origin,
    oauthBaseUrl: input.origin,
    apiVersion: '2026-03-10',
    requestTimeoutMs: 1_000,
    userAgent: 'shipgate-contract-test',
    tokenCipher: input.cipher,
    userTokenStore: input.store,
    tokenEarlyRefreshMs: 5_000,
    refreshLeaseMs: 3_000,
    refreshLeasePollMs: 10,
    now: input.now,
  })
}

async function startMockGitHubServer(state: MockState): Promise<{
  readonly origin: string
  close(): Promise<void>
}> {
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(state, request, response)
    } catch (error) {
      response.statusCode = 500
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
      )
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function handleRequest(
  state: MockState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')

  if (request.method === 'POST' && url.pathname === '/login/oauth/access_token') {
    const parameters = new URLSearchParams(await readBody(request))

    if (parameters.get('grant_type') === 'refresh_token') {
      state.refreshes += 1

      if (state.revokeRefreshToken) {
        sendJson(response, 400, {
          error: 'bad_refresh_token',
          error_description: 'The refresh token was revoked',
        })
        return
      }
    } else {
      state.authorizationExchanges += 1
      state.lastAuthorizationExchange = Object.fromEntries(parameters)
    }

    state.tokenSequence += 1
    sendJson(response, 200, createOAuthTokenFixture(state.tokenSequence))
    return
  }

  if (request.method === 'GET' && url.pathname === '/user') {
    sendJson(response, 200, githubUserFixture)
    return
  }

  if (request.method === 'GET' && url.pathname === '/user/installations') {
    sendJson(response, 200, {
      total_count: 1,
      installations: [installationFixture()],
    })
    return
  }

  if (request.method === 'GET' && url.pathname === '/user/installations/123/repositories') {
    sendJson(response, 200, {
      total_count: 1,
      repositories: [githubRepositoryFixture],
    })
    return
  }

  if (request.method === 'GET' && url.pathname === '/installation/repositories') {
    sendJson(response, 200, {
      total_count: 1,
      repositories: [githubRepositoryFixture],
    })
    return
  }

  if (request.method === 'GET' && url.pathname === '/app/installations/123') {
    sendJson(response, 200, installationFixture())
    return
  }

  if (request.method === 'POST' && url.pathname === '/app/installations/123/access_tokens') {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    state.installationTokenRequests = [...state.installationTokenRequests, body]
    sendJson(response, 201, {
      token: 'installation-token',
      expires_at: '2026-08-03T15:00:00.000Z',
    })
    return
  }

  if (request.method === 'GET' && url.pathname === '/rate-limit') {
    state.rateLimitRequests += 1
    response.statusCode = 403
    response.setHeader('content-type', 'application/json')
    response.setHeader('retry-after', '7')
    response.setHeader('x-ratelimit-remaining', '0')
    response.end(JSON.stringify({ message: 'API rate limit exceeded' }))
    return
  }

  sendJson(response, 404, {
    message: `Unhandled contract route: ${request.method} ${url.pathname}`,
  })
}

function installationFixture() {
  return {
    id: 123,
    account: {
      id: 99,
      login: 'octocat',
      type: 'User',
      avatar_url: githubUserFixture.avatar_url,
    },
    target_type: 'User',
    repository_selection: 'selected',
    permissions: {
      metadata: 'read',
      contents: 'write',
    },
    suspended_at: null,
  } as const
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString('utf8')
}
