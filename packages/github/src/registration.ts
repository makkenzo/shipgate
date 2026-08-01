export const GITHUB_API_VERSION = '2026-03-10'

export const GITHUB_APP_CALLBACK_PATH = '/api/v1/auth/github/callback'

export const GITHUB_APP_WEBHOOK_PATH = '/api/v1/github/webhooks'

/*
 * GitHub names the "Commit statuses" permission `statuses`
 * in manifests and REST responses.
 */
export const GITHUB_APP_REPOSITORY_PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
  checks: 'write',
  statuses: 'read',
  administration: 'read',
  workflows: 'write',
} as const

export const GITHUB_APP_WEBHOOK_EVENTS = [
  'pull_request',
  'push',
  'check_run',
  'status',
  'repository',
  'branch_protection_rule',
  'repository_ruleset',
] as const

export const GITHUB_APP_LIFECYCLE_EVENTS = [
  'installation',
  'installation_repositories',
  'github_app_authorization',
] as const

export const GITHUB_APP_EVENTS = [
  ...GITHUB_APP_WEBHOOK_EVENTS,
  ...GITHUB_APP_LIFECYCLE_EVENTS,
] as const

export interface GitHubAppManifest {
  readonly name: string
  readonly url: string
  readonly description: string
  readonly hook_attributes: {
    readonly url: string
    readonly active: true
  }
  readonly callback_urls: readonly [string]
  readonly request_oauth_on_install: true
  readonly public: false
  readonly default_permissions: typeof GITHUB_APP_REPOSITORY_PERMISSIONS
  readonly default_events: typeof GITHUB_APP_WEBHOOK_EVENTS
}

export interface GitHubAppExpectedRegistration {
  readonly appOrigin: string
  readonly callbackUrl: string
  readonly webhookUrl: string
  readonly repositoryPermissions: typeof GITHUB_APP_REPOSITORY_PERMISSIONS
  readonly subscribedEvents: typeof GITHUB_APP_WEBHOOK_EVENTS
  readonly lifecycleEvents: typeof GITHUB_APP_LIFECYCLE_EVENTS
  readonly userTokensExpire: true
}

export function createGitHubAppManifest(appOrigin: string): GitHubAppManifest {
  const registration = createExpectedGitHubAppRegistration(appOrigin)

  return {
    name: 'Shipgate Release',
    url: registration.appOrigin,
    description: 'Release control plane for GitHub repositories.',

    hook_attributes: {
      url: registration.webhookUrl,
      active: true,
    },

    callback_urls: [registration.callbackUrl],
    request_oauth_on_install: true,
    public: false,
    default_permissions: GITHUB_APP_REPOSITORY_PERMISSIONS,
    default_events: GITHUB_APP_WEBHOOK_EVENTS,
  }
}

export function createExpectedGitHubAppRegistration(
  appOrigin: string,
): GitHubAppExpectedRegistration {
  const normalizedOrigin = normalizeHttpsOrigin(appOrigin)

  return {
    appOrigin: normalizedOrigin,
    callbackUrl: new URL(GITHUB_APP_CALLBACK_PATH, normalizedOrigin).href,
    webhookUrl: new URL(GITHUB_APP_WEBHOOK_PATH, normalizedOrigin).href,
    repositoryPermissions: GITHUB_APP_REPOSITORY_PERMISSIONS,
    subscribedEvents: GITHUB_APP_WEBHOOK_EVENTS,
    lifecycleEvents: GITHUB_APP_LIFECYCLE_EVENTS,
    userTokensExpire: true,
  }
}

export function normalizeHttpsOrigin(value: string): string {
  const url = new URL(value)

  if (url.protocol !== 'https:') {
    throw new TypeError('APP_ORIGIN must use https://')
  }

  if (
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('APP_ORIGIN must be an exact HTTPS origin without a path')
  }

  return url.origin
}
