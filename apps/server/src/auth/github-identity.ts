import type { UserGitHubClient } from '@shipgate/github'

import type { GitHubInstallationSummary, GitHubUserIdentity } from './model.js'

const installationPageSize = 100
const maximumInstallationPages = 100

export function createGitHubAuthorizeUrl(input: {
  readonly oauthOrigin: string
  readonly clientId: string
  readonly callbackUrl: string
  readonly state: string
  readonly codeChallenge: string
}): string {
  const url = new URL('/login/oauth/authorize', input.oauthOrigin)

  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.callbackUrl,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  }).toString()

  return url.href
}

export async function loadGitHubUserIdentity(
  client: UserGitHubClient,
): Promise<GitHubUserIdentity> {
  const profileResponse = await client.request('GET /user')
  const profile = parseUserProfile(profileResponse.data)
  const installations = await listInstallations(client)

  return {
    ...profile,
    installations,
  }
}

async function listInstallations(
  client: UserGitHubClient,
): Promise<readonly GitHubInstallationSummary[]> {
  const installations: GitHubInstallationSummary[] = []
  let totalCount: number | undefined

  for (let page = 1; page <= maximumInstallationPages; page += 1) {
    const response = await client.request('GET /user/installations', {
      per_page: installationPageSize,
      page,
    })
    const parsed = parseInstallationsPage(response.data)

    totalCount ??= parsed.totalCount
    installations.push(...parsed.installations)

    if (
      parsed.installations.length < installationPageSize ||
      (totalCount !== undefined && installations.length >= totalCount)
    ) {
      return installations
    }
  }

  throw new Error(
    `GitHub returned more than ${maximumInstallationPages * installationPageSize} installations`,
  )
}

function parseUserProfile(value: unknown): Omit<GitHubUserIdentity, 'installations'> {
  if (!isRecord(value)) {
    throw new Error('GitHub GET /user returned an invalid response body')
  }

  const githubUserId = getPositiveInteger(value.id)
  const login = getNonEmptyString(value.login)
  const htmlUrl = getNonEmptyString(value.html_url)

  if (githubUserId === undefined || login === undefined || htmlUrl === undefined) {
    throw new Error('GitHub GET /user response is missing stable identity fields')
  }

  return {
    githubUserId,
    login,
    avatarUrl: getNullableString(value.avatar_url),
    displayName: getNullableString(value.name),
    email: getNullableString(value.email),
    htmlUrl,
  }
}

function parseInstallationsPage(value: unknown): {
  readonly totalCount: number | undefined
  readonly installations: readonly GitHubInstallationSummary[]
} {
  if (!isRecord(value) || !Array.isArray(value.installations)) {
    throw new Error('GitHub GET /user/installations returned an invalid response body')
  }

  return {
    totalCount: getNonNegativeInteger(value.total_count),
    installations: value.installations.map(parseInstallation),
  }
}

function parseInstallation(value: unknown): GitHubInstallationSummary {
  if (!isRecord(value) || !isRecord(value.account)) {
    throw new Error('GitHub installation response is invalid')
  }

  const id = getPositiveInteger(value.id)
  const accountId = getPositiveInteger(value.account.id)
  const accountLogin = getNonEmptyString(value.account.login)
  const accountType = getNonEmptyString(value.account.type)
  const repositorySelection = value.repository_selection

  if (
    id === undefined ||
    accountId === undefined ||
    accountLogin === undefined ||
    accountType === undefined ||
    (repositorySelection !== 'all' && repositorySelection !== 'selected')
  ) {
    throw new Error('GitHub installation response is missing stable identity fields')
  }

  return {
    id,
    account: {
      id: accountId,
      login: accountLogin,
      type: accountType,
      avatarUrl: getNullableString(value.account.avatar_url),
    },
    repositorySelection,
    permissions: getStringRecord(value.permissions),
    suspendedAt: getNullableString(value.suspended_at),
  }
}

function getStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    return {}
  }

  const result: Record<string, string> = {}

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      result[key] = item
    }
  }

  return result
}

function getPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function getNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function getNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}
