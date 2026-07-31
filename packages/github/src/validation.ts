import {
  createGitHubAppApiClient,
  GitHubApiRequestError,
  type GitHubPermissionLevel,
} from './api.js'
import { createGitHubAppJwt, GitHubPrivateKeyError, loadGitHubAppPrivateKey } from './jwt.js'
import { createAes256GcmGitHubTokenCipher, GitHubTokenEncryptionError } from './token-cipher.js'
import {
  createExpectedGitHubAppRegistration,
  GITHUB_API_VERSION,
  GITHUB_APP_LIFECYCLE_EVENTS,
  type GitHubAppExpectedRegistration,
} from './registration.js'

export type GitHubAppValidationStatus = 'passed' | 'failed' | 'skipped'

export type GitHubAppValidationSource = 'local' | 'github'

export interface GitHubAppValidationCheck {
  readonly id: string
  readonly status: GitHubAppValidationStatus
  readonly source: GitHubAppValidationSource
  readonly message: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface GitHubAppValidationReport {
  readonly ok: boolean
  readonly checks: readonly GitHubAppValidationCheck[]
  readonly app:
    | {
        readonly id: number
        readonly slug: string | undefined
        readonly clientId: string | undefined
      }
    | undefined
  readonly expectedRegistration: GitHubAppExpectedRegistration | undefined

  /**
   * GitHub does not expose these settings through an app-authenticated REST
   * endpoint. They are validated against Shipgate's canonical registration
   * manifest, but remote drift can only be caught during the OAuth flow or by
   * reviewing the GitHub App settings page.
   */
  readonly remoteVerificationLimitations: readonly [
    'callback_url',
    'user_token_expiration',
    'client_secret',
  ]
}

export interface ValidateGitHubAppRegistrationOptions {
  readonly appOrigin: string | undefined
  readonly appId: number | undefined
  readonly clientId: string | undefined
  readonly privateKey: string | undefined
  readonly clientSecret: string | undefined
  readonly webhookSecret: string | undefined
  readonly tokenEncryptionKey: string | undefined
  readonly tokenEncryptionKeyId?: string
  readonly userTokensExpire: boolean | undefined
  readonly apiBaseUrl?: string
  readonly apiVersion?: string
  readonly requestTimeoutMs?: number
  readonly fetchImplementation?: typeof fetch
  readonly now?: Date
}

export class GitHubAppValidationError extends Error {
  readonly report: GitHubAppValidationReport

  constructor(report: GitHubAppValidationReport) {
    const failedChecks = report.checks.filter((check) => check.status === 'failed')

    super(`GitHub App validation failed: ${failedChecks.map((check) => check.id).join(', ')}`)

    this.name = 'GitHubAppValidationError'
    this.report = report
  }
}

export async function validateGitHubAppRegistration(
  options: ValidateGitHubAppRegistrationOptions,
): Promise<GitHubAppValidationReport> {
  const checks: GitHubAppValidationCheck[] = []

  const expectedRegistration = validateExpectedRegistration(options.appOrigin, checks)

  const appId = validateAppId(options.appId, checks)
  const clientId = validateClientId(options.clientId, checks)

  validateClientSecret(options.clientSecret, checks)
  validateWebhookSecret(options.webhookSecret, checks)
  validateTokenEncryption(
    options.tokenEncryptionKey,
    options.tokenEncryptionKeyId ?? 'primary',
    checks,
  )
  validateUserTokenExpiration(options.userTokensExpire, checks)

  checks.push({
    id: 'registration.lifecycle_events',
    status: 'passed',
    source: 'local',
    message: 'Required GitHub App lifecycle events are implicit',
    details: {
      events: GITHUB_APP_LIFECYCLE_EVENTS,
    },
  })

  if (expectedRegistration) {
    checks.push({
      id: 'registration.callback_url',
      status: 'passed',
      source: 'local',
      message: `Canonical callback URL is ${expectedRegistration.callbackUrl}`,
    })
  } else {
    checks.push({
      id: 'registration.callback_url',
      status: 'skipped',
      source: 'local',
      message: 'Callback URL cannot be derived until APP_ORIGIN is valid',
    })
  }

  const privateKey = validatePrivateKey(options.privateKey, checks)

  let jwt: string | undefined

  if (appId !== undefined && privateKey !== undefined) {
    try {
      jwt = createGitHubAppJwt({
        appId,
        privateKey,
        ...(options.now !== undefined ? { now: options.now } : {}),
      })

      checks.push({
        id: 'crypto.app_jwt',
        status: 'passed',
        source: 'local',
        message: 'App JWT was created and signed with RS256',
      })
    } catch (error) {
      checks.push({
        id: 'crypto.app_jwt',
        status: 'failed',
        source: 'local',
        message: error instanceof Error ? error.message : 'Unable to create App JWT',
      })
    }
  } else {
    checks.push({
      id: 'crypto.app_jwt',
      status: 'skipped',
      source: 'local',
      message: 'App JWT creation requires a valid App ID and private key',
    })
  }

  let app: GitHubAppValidationReport['app']

  if (jwt !== undefined && appId !== undefined) {
    const client = createGitHubAppApiClient({
      apiBaseUrl: options.apiBaseUrl ?? 'https://api.github.com',
      apiVersion: options.apiVersion ?? GITHUB_API_VERSION,
      jwt,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      ...(options.fetchImplementation !== undefined
        ? { fetchImplementation: options.fetchImplementation }
        : {}),
    })

    let authenticatedAppAvailable = false

    try {
      const authenticatedApp = await client.getAuthenticatedApp()
      authenticatedAppAvailable = true
      app = {
        id: authenticatedApp.id,
        slug: authenticatedApp.slug,
        clientId: authenticatedApp.clientId,
      }

      const authenticatedAppName = authenticatedApp.slug ?? `App ${authenticatedApp.id}`

      checks.push({
        id: 'github.authenticated_app',
        status: 'passed',
        source: 'github',
        message: `GET /app authenticated as ${authenticatedAppName}`,
        details: {
          appId: authenticatedApp.id,
          clientId: authenticatedApp.clientId,
        },
      })

      compareAppId(authenticatedApp.id, appId, checks)
      compareClientId(authenticatedApp.clientId, clientId, checks)
      comparePermissions(authenticatedApp.permissions, expectedRegistration, checks)
      compareEvents(authenticatedApp.events, expectedRegistration, checks)
    } catch (error) {
      checks.push(mapGitHubApiError('github.authenticated_app', '/app', error))
      addSkippedAuthenticatedAppChecks(checks)
    }

    if (authenticatedAppAvailable) {
      try {
        const webhook = await client.getWebhookConfig()

        checks.push({
          id: 'github.webhook_config',
          status: 'passed',
          source: 'github',
          message: 'GET /app/hook/config returned the webhook configuration',
        })

        compareWebhookUrl(webhook.url, expectedRegistration, checks)
        compareWebhookSecret(webhook.secret, checks)
        compareWebhookSsl(webhook.insecureSsl, checks)
        compareWebhookContentType(webhook.contentType, checks)
      } catch (error) {
        checks.push(mapGitHubApiError('github.webhook_config', '/app/hook/config', error))
        addSkippedWebhookChecks(checks)
      }
    } else {
      checks.push({
        id: 'github.webhook_config',
        status: 'skipped',
        source: 'github',
        message: 'Webhook configuration was not requested because GET /app failed',
      })

      addSkippedWebhookChecks(checks)
    }
  } else {
    checks.push({
      id: 'github.authenticated_app',
      status: 'skipped',
      source: 'github',
      message: 'GET /app requires a valid App JWT',
    })

    addSkippedAuthenticatedAppChecks(checks)

    checks.push({
      id: 'github.webhook_config',
      status: 'skipped',
      source: 'github',
      message: 'GET /app/hook/config requires a valid App JWT',
    })

    addSkippedWebhookChecks(checks)
  }

  return {
    ok: checks.every((check) => check.status !== 'failed'),
    checks,
    app,
    expectedRegistration,
    remoteVerificationLimitations: ['callback_url', 'user_token_expiration', 'client_secret'],
  }
}

export async function assertGitHubAppRegistration(
  options: ValidateGitHubAppRegistrationOptions,
): Promise<GitHubAppValidationReport> {
  const report = await validateGitHubAppRegistration(options)

  if (!report.ok) {
    throw new GitHubAppValidationError(report)
  }

  return report
}

function validateExpectedRegistration(
  appOrigin: string | undefined,
  checks: GitHubAppValidationCheck[],
): GitHubAppExpectedRegistration | undefined {
  if (!appOrigin) {
    checks.push({
      id: 'config.app_origin',
      status: 'failed',
      source: 'local',
      message: 'APP_ORIGIN is required for GitHub App validation',
    })

    return undefined
  }

  try {
    const registration = createExpectedGitHubAppRegistration(appOrigin)

    checks.push({
      id: 'config.app_origin',
      status: 'passed',
      source: 'local',
      message: `APP_ORIGIN is the exact HTTPS origin ${registration.appOrigin}`,
    })

    return registration
  } catch (error) {
    checks.push({
      id: 'config.app_origin',
      status: 'failed',
      source: 'local',
      message: error instanceof Error ? error.message : 'APP_ORIGIN is invalid',
      details: {
        value: appOrigin,
      },
    })

    return undefined
  }
}

function validateAppId(
  appId: number | undefined,
  checks: GitHubAppValidationCheck[],
): number | undefined {
  if (appId === undefined) {
    checks.push({
      id: 'config.app_id',
      status: 'failed',
      source: 'local',
      message: 'GITHUB_APP_ID is required',
    })

    return undefined
  }

  if (!Number.isSafeInteger(appId) || appId <= 0) {
    checks.push({
      id: 'config.app_id',
      status: 'failed',
      source: 'local',
      message: 'GITHUB_APP_ID must be a positive safe integer',
      details: {
        value: appId,
      },
    })

    return undefined
  }

  checks.push({
    id: 'config.app_id',
    status: 'passed',
    source: 'local',
    message: `Expected GitHub App ID is ${appId}`,
  })

  return appId
}

function validateClientId(
  clientId: string | undefined,
  checks: GitHubAppValidationCheck[],
): string | undefined {
  if (!clientId || clientId.trim().length === 0) {
    checks.push({
      id: 'config.client_id',
      status: 'failed',
      source: 'local',
      message: 'GITHUB_APP_CLIENT_ID is required',
    })

    return undefined
  }

  checks.push({
    id: 'config.client_id',
    status: 'passed',
    source: 'local',
    message: `Expected GitHub App client ID is ${clientId}`,
  })

  return clientId
}

function validateClientSecret(
  clientSecret: string | undefined,
  checks: GitHubAppValidationCheck[],
): void {
  if (!clientSecret || clientSecret.trim().length === 0) {
    checks.push({
      id: 'config.client_secret',
      status: 'failed',
      source: 'local',
      message: 'GITHUB_APP_CLIENT_SECRET must be configured',
    })

    return
  }

  checks.push({
    id: 'config.client_secret',
    status: 'passed',
    source: 'local',
    message: 'A local GitHub App client secret is configured',
  })
}

function validateTokenEncryption(
  encryptionKey: string | undefined,
  encryptionKeyId: string,
  checks: GitHubAppValidationCheck[],
): void {
  if (!encryptionKey) {
    checks.push({
      id: 'crypto.user_token_encryption',
      status: 'failed',
      source: 'local',
      message: 'GITHUB_TOKEN_ENCRYPTION_KEY must be configured',
    })

    return
  }

  try {
    const cipher = createAes256GcmGitHubTokenCipher({
      key: encryptionKey,
      keyId: encryptionKeyId,
    })
    const encryptedToken = cipher.encrypt({
      userId: 1,
      purpose: 'refresh',
      token: 'shipgate-github-doctor-probe',
    })
    const decryptedToken = cipher.decrypt({
      userId: 1,
      purpose: 'refresh',
      encryptedToken,
    })

    if (decryptedToken !== 'shipgate-github-doctor-probe') {
      throw new GitHubTokenEncryptionError('GitHub token encryption round trip failed')
    }

    checks.push({
      id: 'crypto.user_token_encryption',
      status: 'passed',
      source: 'local',
      message: `AES-256-GCM user-token encryption is configured with key ID ${encryptionKeyId}`,
    })
  } catch (error) {
    checks.push({
      id: 'crypto.user_token_encryption',
      status: 'failed',
      source: 'local',
      message:
        error instanceof GitHubTokenEncryptionError
          ? error.message
          : 'GitHub token encryption configuration is invalid',
    })
  }
}

function validateWebhookSecret(
  webhookSecret: string | undefined,
  checks: GitHubAppValidationCheck[],
): void {
  if (!webhookSecret || webhookSecret.trim().length === 0) {
    checks.push({
      id: 'config.webhook_secret',
      status: 'failed',
      source: 'local',
      message: 'GITHUB_APP_WEBHOOK_SECRET must be configured',
    })

    return
  }

  checks.push({
    id: 'config.webhook_secret',
    status: 'passed',
    source: 'local',
    message: 'A local GitHub webhook secret is configured',
  })
}

function validateUserTokenExpiration(
  userTokensExpire: boolean | undefined,
  checks: GitHubAppValidationCheck[],
): void {
  if (userTokensExpire !== true) {
    checks.push({
      id: 'registration.user_token_expiration',
      status: 'failed',
      source: 'local',
      message: 'GITHUB_APP_USER_TOKENS_EXPIRE must be explicitly set to true',
    })

    return
  }

  checks.push({
    id: 'registration.user_token_expiration',
    status: 'passed',
    source: 'local',
    message: 'Production registration requires expiring user access tokens',
  })
}

function validatePrivateKey(
  privateKeyValue: string | undefined,
  checks: GitHubAppValidationCheck[],
): ReturnType<typeof loadGitHubAppPrivateKey> | undefined {
  if (!privateKeyValue) {
    checks.push({
      id: 'crypto.private_key',
      status: 'failed',
      source: 'local',
      message: 'GITHUB_APP_PRIVATE_KEY is required',
    })

    return undefined
  }

  try {
    const privateKey = loadGitHubAppPrivateKey(privateKeyValue)

    checks.push({
      id: 'crypto.private_key',
      status: 'passed',
      source: 'local',
      message: 'GitHub App RSA private key loaded successfully',
    })

    return privateKey
  } catch (error) {
    checks.push({
      id: 'crypto.private_key',
      status: 'failed',
      source: 'local',
      message:
        error instanceof GitHubPrivateKeyError
          ? error.message
          : 'GITHUB_APP_PRIVATE_KEY could not be loaded',
    })

    return undefined
  }
}

function compareAppId(
  actualAppId: number,
  expectedAppId: number,
  checks: GitHubAppValidationCheck[],
): void {
  if (actualAppId !== expectedAppId) {
    checks.push({
      id: 'github.app_id',
      status: 'failed',
      source: 'github',
      message: 'Authenticated GitHub App ID does not match GITHUB_APP_ID',
      details: {
        expected: expectedAppId,
        actual: actualAppId,
      },
    })

    return
  }

  checks.push({
    id: 'github.app_id',
    status: 'passed',
    source: 'github',
    message: `GET /app returned the expected App ID ${expectedAppId}`,
  })
}

function compareClientId(
  actualClientId: string | undefined,
  expectedClientId: string | undefined,
  checks: GitHubAppValidationCheck[],
): void {
  if (expectedClientId === undefined) {
    checks.push({
      id: 'github.client_id',
      status: 'skipped',
      source: 'github',
      message: 'GitHub App client ID cannot be compared until GITHUB_APP_CLIENT_ID is valid',
    })

    return
  }

  if (actualClientId !== expectedClientId) {
    checks.push({
      id: 'github.client_id',
      status: 'failed',
      source: 'github',
      message: 'Authenticated GitHub App client ID does not match GITHUB_APP_CLIENT_ID',
      details: {
        expected: expectedClientId,
        actual: actualClientId,
      },
    })

    return
  }

  checks.push({
    id: 'github.client_id',
    status: 'passed',
    source: 'github',
    message: `GET /app returned the expected client ID ${expectedClientId}`,
  })
}

function comparePermissions(
  actual: Readonly<Record<string, GitHubPermissionLevel>>,
  expectedRegistration: GitHubAppExpectedRegistration | undefined,
  checks: GitHubAppValidationCheck[],
): void {
  if (!expectedRegistration) {
    checks.push({
      id: 'github.permissions',
      status: 'skipped',
      source: 'github',
      message: 'Expected permissions are unavailable because APP_ORIGIN is invalid',
    })

    return
  }

  const expected = expectedRegistration.repositoryPermissions
  const missingOrWrong: Array<Readonly<Record<string, unknown>>> = []
  const unexpected: Array<Readonly<Record<string, unknown>>> = []

  for (const [permission, expectedLevel] of Object.entries(expected)) {
    const actualLevel = actual[permission]

    if (actualLevel !== expectedLevel) {
      missingOrWrong.push({
        permission,
        expected: expectedLevel,
        actual: actualLevel ?? 'none',
      })
    }
  }

  for (const [permission, actualLevel] of Object.entries(actual)) {
    if (!(permission in expected)) {
      unexpected.push({
        permission,
        actual: actualLevel,
      })
    }
  }

  if (missingOrWrong.length > 0 || unexpected.length > 0) {
    checks.push({
      id: 'github.permissions',
      status: 'failed',
      source: 'github',
      message: 'GitHub App repository permissions do not match the production registration',
      details: {
        missingOrWrong,
        unexpected,
        expected,
        actual,
      },
    })

    return
  }

  checks.push({
    id: 'github.permissions',
    status: 'passed',
    source: 'github',
    message: 'GitHub App repository permissions exactly match the production registration',
    details: {
      permissions: expected,
    },
  })
}

function compareEvents(
  actualEvents: readonly string[],
  expectedRegistration: GitHubAppExpectedRegistration | undefined,
  checks: GitHubAppValidationCheck[],
): void {
  if (!expectedRegistration) {
    checks.push({
      id: 'github.events',
      status: 'skipped',
      source: 'github',
      message: 'Expected events are unavailable because APP_ORIGIN is invalid',
    })

    return
  }

  const expectedEvents = [...expectedRegistration.subscribedEvents].sort()
  const expectedEventSet = new Set<string>(expectedEvents)
  const normalizedActualEvents = [...new Set(actualEvents)].sort()
  const actualEventSet = new Set<string>(normalizedActualEvents)
  const missing = expectedEvents.filter((event) => !actualEventSet.has(event))
  const unexpected = normalizedActualEvents.filter((event) => !expectedEventSet.has(event))

  if (missing.length > 0 || unexpected.length > 0) {
    checks.push({
      id: 'github.events',
      status: 'failed',
      source: 'github',
      message: 'GitHub App webhook subscriptions do not match the production registration',
      details: {
        missing,
        unexpected,
        expected: expectedEvents,
        actual: normalizedActualEvents,
      },
    })

    return
  }

  checks.push({
    id: 'github.events',
    status: 'passed',
    source: 'github',
    message: 'GitHub App webhook subscriptions exactly match the production registration',
    details: {
      events: expectedEvents,
    },
  })
}

function compareWebhookUrl(
  actualUrl: string | undefined,
  expectedRegistration: GitHubAppExpectedRegistration | undefined,
  checks: GitHubAppValidationCheck[],
): void {
  if (!expectedRegistration) {
    checks.push({
      id: 'github.webhook_url',
      status: 'skipped',
      source: 'github',
      message: 'Expected webhook URL is unavailable because APP_ORIGIN is invalid',
    })

    return
  }

  if (actualUrl !== expectedRegistration.webhookUrl) {
    checks.push({
      id: 'github.webhook_url',
      status: 'failed',
      source: 'github',
      message: `GitHub webhook URL must be ${expectedRegistration.webhookUrl}`,
      details: {
        expected: expectedRegistration.webhookUrl,
        actual: actualUrl ?? 'not configured',
      },
    })

    return
  }

  checks.push({
    id: 'github.webhook_url',
    status: 'passed',
    source: 'github',
    message: `GitHub webhook URL matches APP_ORIGIN: ${actualUrl}`,
  })
}

function compareWebhookSecret(
  remoteSecret: string | undefined,
  checks: GitHubAppValidationCheck[],
): void {
  if (!remoteSecret || remoteSecret.trim().length === 0) {
    checks.push({
      id: 'github.webhook_secret',
      status: 'failed',
      source: 'github',
      message: 'GitHub reports that no webhook secret is configured',
    })

    return
  }

  checks.push({
    id: 'github.webhook_secret',
    status: 'passed',
    source: 'github',
    message: 'GitHub reports that a webhook secret is configured',
  })
}

function compareWebhookSsl(
  insecureSsl: string | number | undefined,
  checks: GitHubAppValidationCheck[],
): void {
  if (String(insecureSsl) !== '0') {
    checks.push({
      id: 'github.webhook_ssl',
      status: 'failed',
      source: 'github',
      message: 'GitHub webhook SSL verification must be enabled (insecure_ssl=0)',
      details: {
        actual: insecureSsl ?? 'missing',
      },
    })

    return
  }

  checks.push({
    id: 'github.webhook_ssl',
    status: 'passed',
    source: 'github',
    message: 'GitHub webhook SSL certificate verification is enabled',
  })
}

function compareWebhookContentType(
  contentType: string | undefined,
  checks: GitHubAppValidationCheck[],
): void {
  if (contentType !== 'json') {
    checks.push({
      id: 'github.webhook_content_type',
      status: 'failed',
      source: 'github',
      message: 'GitHub webhook content type must be json',
      details: {
        actual: contentType ?? 'missing',
      },
    })

    return
  }

  checks.push({
    id: 'github.webhook_content_type',
    status: 'passed',
    source: 'github',
    message: 'GitHub webhook content type is json',
  })
}

function mapGitHubApiError(
  checkId: string,
  path: string,
  error: unknown,
): GitHubAppValidationCheck {
  if (!(error instanceof GitHubApiRequestError)) {
    return {
      id: checkId,
      status: 'failed',
      source: 'github',
      message: error instanceof Error ? error.message : `GitHub API ${path} request failed`,
    }
  }

  const details = {
    path: error.path,
    status: error.status,
    requestId: error.requestId,
    responseMessage: error.responseMessage,
  }

  switch (error.status) {
    case 401:
      return {
        id: checkId,
        status: 'failed',
        source: 'github',
        message: [
          'GitHub rejected the App JWT (401).',
          'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY may belong to different apps,',
          'the key may be revoked, or the system clock may be incorrect.',
        ].join(' '),
        details,
      }

    case 403:
      return {
        id: checkId,
        status: 'failed',
        source: 'github',
        message: `GitHub accepted the request but denied access to ${path} (403)`,
        details,
      }

    case 404:
      return {
        id: checkId,
        status: 'failed',
        source: 'github',
        message: `GitHub API endpoint ${path} was not found (404); check GITHUB_API_URL`,
        details,
      }

    default:
      return {
        id: checkId,
        status: 'failed',
        source: 'github',
        message: error.message,
        details,
      }
  }
}

function addSkippedAuthenticatedAppChecks(checks: GitHubAppValidationCheck[]): void {
  checks.push(
    {
      id: 'github.app_id',
      status: 'skipped',
      source: 'github',
      message: 'App ID comparison requires a successful GET /app response',
    },
    {
      id: 'github.client_id',
      status: 'skipped',
      source: 'github',
      message: 'Client ID comparison requires a successful GET /app response',
    },
    {
      id: 'github.permissions',
      status: 'skipped',
      source: 'github',
      message: 'Permission comparison requires a successful GET /app response',
    },
    {
      id: 'github.events',
      status: 'skipped',
      source: 'github',
      message: 'Event comparison requires a successful GET /app response',
    },
  )
}

function addSkippedWebhookChecks(checks: GitHubAppValidationCheck[]): void {
  checks.push(
    {
      id: 'github.webhook_url',
      status: 'skipped',
      source: 'github',
      message: 'Webhook URL comparison requires GET /app/hook/config',
    },
    {
      id: 'github.webhook_secret',
      status: 'skipped',
      source: 'github',
      message: 'Remote webhook secret check requires GET /app/hook/config',
    },
    {
      id: 'github.webhook_ssl',
      status: 'skipped',
      source: 'github',
      message: 'Webhook SSL check requires GET /app/hook/config',
    },
    {
      id: 'github.webhook_content_type',
      status: 'skipped',
      source: 'github',
      message: 'Webhook content type check requires GET /app/hook/config',
    },
  )
}
