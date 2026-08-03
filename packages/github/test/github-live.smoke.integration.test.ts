import {
  createAes256GcmGitHubTokenCipher,
  createGitHubAuthenticationService,
} from '@shipgate/github'
import { createInMemoryGitHubUserTokenStore } from '@shipgate/github/testing'
import { describe, expect, it } from 'vitest'

const smokeEnabled = process.env.GITHUB_SMOKE_TEST === 'true'

describe.skipIf(!smokeEnabled)('GitHub test App smoke', () => {
  it('authenticates the App and reads a scoped installation repository page', async () => {
    const appId = readPositiveIntegerEnvironment('GITHUB_APP_ID')
    const installationId = readPositiveIntegerEnvironment('GITHUB_SMOKE_INSTALLATION_ID')
    const service = createGitHubAuthenticationService({
      appId,
      clientId: process.env.GITHUB_APP_CLIENT_ID ?? 'smoke-client-id',
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? 'smoke-client-secret',
      privateKey: readEnvironment('GITHUB_APP_PRIVATE_KEY').replaceAll('\\n', '\n'),
      apiBaseUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
      oauthBaseUrl: process.env.GITHUB_OAUTH_URL ?? 'https://github.com',
      apiVersion: process.env.GITHUB_API_VERSION ?? '2026-03-10',
      requestTimeoutMs: 10_000,
      userAgent: 'shipgate-github-smoke',
      tokenCipher: createAes256GcmGitHubTokenCipher({
        key: Buffer.alloc(32, 12).toString('base64url'),
      }),
      userTokenStore: createInMemoryGitHubUserTokenStore(),
    })

    const appClient = await service.getAppClient()
    const app = await appClient.request('GET /app')
    expect(app.data).toMatchObject({ id: appId })

    const installationClient = await service.getInstallationClient({
      installationId,
      permissions: { metadata: 'read' },
    })
    const repositories = await installationClient.request('GET /installation/repositories', {
      per_page: 1,
      page: 1,
    })

    expect(repositories.status).toBe(200)
    expect(repositories.data).toMatchObject({ repositories: expect.any(Array) })
  })
})

function readEnvironment(name: string): string {
  const value = process.env[name]

  if (!value) {
    throw new Error(`${name} is required when GITHUB_SMOKE_TEST=true`)
  }

  return value
}

function readPositiveIntegerEnvironment(name: string): number {
  const value = Number(readEnvironment(name))

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }

  return value
}
