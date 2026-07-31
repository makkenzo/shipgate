import { generateKeyPairSync } from 'node:crypto'

import {
  createGitHubAppManifest,
  GITHUB_APP_REPOSITORY_PERMISSIONS,
  GITHUB_APP_WEBHOOK_EVENTS,
  validateGitHubAppRegistration,
} from '@shipgate/github'
import { describe, expect, it, vi } from 'vitest'

const appOrigin = 'https://shipgate.example'
const appId = 123_456
const clientId = 'Iv1.shipgate'
const clientSecret = 'test-client-secret'
const tokenEncryptionKey = Buffer.alloc(32, 7).toString('base64url')
const webhookSecret = 'test-webhook-secret-with-entropy'

const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2_048,
})
  .privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  })
  .toString()

describe('GitHub App registration validation', () => {
  it('validates the canonical production registration', async () => {
    const fetchImplementation = createGitHubFetch()

    const report = await validateGitHubAppRegistration({
      appOrigin,
      appId,
      clientId,
      privateKey,
      clientSecret,
      webhookSecret,
      tokenEncryptionKey,
      userTokensExpire: true,
      fetchImplementation,
    })

    expect(report.ok).toBe(true)
    expect(getCheck(report, 'crypto.private_key').status).toBe('passed')
    expect(getCheck(report, 'crypto.app_jwt').status).toBe('passed')
    expect(getCheck(report, 'crypto.user_token_encryption').status).toBe('passed')
    expect(getCheck(report, 'github.app_id').status).toBe('passed')
    expect(getCheck(report, 'github.client_id').status).toBe('passed')
    expect(getCheck(report, 'github.permissions').status).toBe('passed')
    expect(getCheck(report, 'github.events').status).toBe('passed')
    expect(getCheck(report, 'github.webhook_url').status).toBe('passed')
    expect(getCheck(report, 'github.webhook_secret').status).toBe('passed')
    expect(getCheck(report, 'github.webhook_ssl').status).toBe('passed')
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('reports a concrete JWT authentication failure instead of a raw 401', async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'x-github-request-id': 'doctor-test-request',
          },
        }),
    ) as unknown as typeof fetch

    const report = await validateGitHubAppRegistration({
      appOrigin,
      appId,
      clientId,
      privateKey,
      clientSecret,
      webhookSecret,
      tokenEncryptionKey,
      userTokensExpire: true,
      fetchImplementation,
    })

    const check = getCheck(report, 'github.authenticated_app')

    expect(report.ok).toBe(false)
    expect(check.status).toBe('failed')
    expect(check.message).toContain('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY')
    expect(check.details).toMatchObject({
      status: 401,
      requestId: 'doctor-test-request',
    })
  })

  it('detects missing, wrong, and excessive GitHub permissions and events', async () => {
    const fetchImplementation = createGitHubFetch({
      app: {
        id: appId,
        slug: 'shipgate',
        client_id: clientId,
        permissions: {
          ...GITHUB_APP_REPOSITORY_PERMISSIONS,
          contents: 'read',
          issues: 'write',
        },
        events: [
          ...GITHUB_APP_WEBHOOK_EVENTS.filter((event) => event !== 'repository_ruleset'),
          'issues',
        ] as string[],
      },
    })

    const report = await validateGitHubAppRegistration({
      appOrigin,
      appId,
      clientId,
      privateKey,
      clientSecret,
      webhookSecret,
      tokenEncryptionKey,
      userTokensExpire: true,
      fetchImplementation,
    })

    expect(report.ok).toBe(false)
    expect(getCheck(report, 'github.permissions')).toMatchObject({
      status: 'failed',
      details: {
        missingOrWrong: [
          {
            permission: 'contents',
            expected: 'write',
            actual: 'read',
          },
        ],
        unexpected: [
          {
            permission: 'issues',
            actual: 'write',
          },
        ],
      },
    })
    expect(getCheck(report, 'github.events')).toMatchObject({
      status: 'failed',
      details: {
        missing: ['repository_ruleset'],
        unexpected: ['issues'],
      },
    })
  })

  it('detects App identity and webhook configuration drift', async () => {
    const fetchImplementation = createGitHubFetch({
      app: {
        id: appId + 1,
        slug: 'another-app',
        client_id: 'Iv1.another',
        permissions: GITHUB_APP_REPOSITORY_PERMISSIONS,
        events: GITHUB_APP_WEBHOOK_EVENTS,
      },
      webhook: {
        content_type: 'form',
        insecure_ssl: '1',
        secret: '',
        url: 'https://wrong.example/github/webhooks',
      },
    })

    const report = await validateGitHubAppRegistration({
      appOrigin,
      appId,
      clientId,
      privateKey,
      clientSecret,
      webhookSecret,
      tokenEncryptionKey,
      userTokensExpire: true,
      fetchImplementation,
    })

    expect(report.ok).toBe(false)
    expect(getCheck(report, 'github.app_id').status).toBe('failed')
    expect(getCheck(report, 'github.client_id').status).toBe('failed')
    expect(getCheck(report, 'github.webhook_url').status).toBe('failed')
    expect(getCheck(report, 'github.webhook_secret').status).toBe('failed')
    expect(getCheck(report, 'github.webhook_ssl').status).toBe('failed')
    expect(getCheck(report, 'github.webhook_content_type').status).toBe('failed')
  })

  it('requires an explicit expiring-token declaration and a local webhook secret', async () => {
    const fetchImplementation = createGitHubFetch()

    const report = await validateGitHubAppRegistration({
      appOrigin,
      appId,
      clientId,
      privateKey,
      clientSecret,
      webhookSecret: undefined,
      tokenEncryptionKey,
      userTokensExpire: false,
      fetchImplementation,
    })

    expect(report.ok).toBe(false)
    expect(getCheck(report, 'config.webhook_secret').status).toBe('failed')
    expect(getCheck(report, 'registration.user_token_expiration').status).toBe('failed')
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('does not call GitHub when the private key is invalid', async () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch

    const report = await validateGitHubAppRegistration({
      appOrigin,
      appId,
      clientId,
      privateKey: 'not a private key',
      clientSecret,
      webhookSecret,
      tokenEncryptionKey,
      userTokensExpire: true,
      fetchImplementation,
    })

    expect(report.ok).toBe(false)
    expect(getCheck(report, 'crypto.private_key').message).toContain('valid PEM private key')
    expect(getCheck(report, 'crypto.app_jwt').status).toBe('skipped')
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('renders the production GitHub App manifest from APP_ORIGIN', () => {
    expect(createGitHubAppManifest(appOrigin)).toEqual({
      name: 'Shipgate Release',
      url: appOrigin,
      description: 'Release control plane for GitHub repositories.',
      hook_attributes: {
        url: `${appOrigin}/api/v1/github/webhooks`,
        active: true,
      },
      callback_urls: [`${appOrigin}/api/v1/github/oauth/callback`],
      request_oauth_on_install: true,
      public: false,
      default_permissions: GITHUB_APP_REPOSITORY_PERMISSIONS,
      default_events: GITHUB_APP_WEBHOOK_EVENTS,
    })
  })
})

function createGitHubFetch(
  overrides: {
    readonly app?: Readonly<Record<string, unknown>>
    readonly webhook?: Readonly<Record<string, unknown>>
  } = {},
): typeof fetch {
  const app =
    overrides.app ??
    ({
      id: appId,
      slug: 'shipgate',
      client_id: clientId,
      permissions: GITHUB_APP_REPOSITORY_PERMISSIONS,
      events: GITHUB_APP_WEBHOOK_EVENTS,
    } satisfies Readonly<Record<string, unknown>>)

  const webhook =
    overrides.webhook ??
    ({
      content_type: 'json',
      insecure_ssl: '0',
      secret: '********',
      url: `${appOrigin}/api/v1/github/webhooks`,
    } satisfies Readonly<Record<string, unknown>>)

  return vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())

    if (url.pathname === '/app') {
      return Response.json(app)
    }

    if (url.pathname === '/app/hook/config') {
      return Response.json(webhook)
    }

    return Response.json({ message: 'Not Found' }, { status: 404 })
  }) as unknown as typeof fetch
}

function getCheck(report: Awaited<ReturnType<typeof validateGitHubAppRegistration>>, id: string) {
  const check = report.checks.find((candidate) => candidate.id === id)

  if (!check) {
    throw new Error(`Missing validation check ${id}`)
  }

  return check
}
