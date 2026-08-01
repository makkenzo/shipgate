import type { AppGitHubClient, InstallationGitHubClient, UserGitHubClient } from '@shipgate/github'

import type { GitHubInstallationSummary } from '../auth/model.js'
import type {
  GitHubInstallationMetadata,
  GitHubInstallationRepository,
  GitHubRepositoryPermission,
  GitHubUserRepositoryAccess,
} from './model.js'

const pageSize = 100
const maximumPages = 100

export async function loadGitHubInstallationMetadata(
  client: AppGitHubClient,
  installationId: number,
): Promise<GitHubInstallationMetadata> {
  const response = await client.request('GET /app/installations/{installation_id}', {
    installation_id: installationId,
  })

  return parseInstallationMetadata(response.data)
}

export async function listGitHubInstallationRepositories(
  client: InstallationGitHubClient,
): Promise<readonly GitHubInstallationRepository[]> {
  return listRepositories(async (page) => {
    const response = await client.request('GET /installation/repositories', {
      per_page: pageSize,
      page,
    })

    return parseRepositoryPage(response.data, 'GET /installation/repositories')
  })
}

export async function listGitHubUserInstallationRepositories(
  client: UserGitHubClient,
  installationId: number,
): Promise<readonly GitHubUserRepositoryAccess[]> {
  const repositories: GitHubUserRepositoryAccess[] = []
  let totalCount: number | undefined

  for (let page = 1; page <= maximumPages; page += 1) {
    const response = await client.request(
      'GET /user/installations/{installation_id}/repositories',
      {
        installation_id: installationId,
        per_page: pageSize,
        page,
      },
    )
    const parsed = parseUserRepositoryPage(response.data)

    totalCount ??= parsed.totalCount
    repositories.push(...parsed.repositories)

    if (
      parsed.repositories.length < pageSize ||
      (totalCount !== undefined && repositories.length >= totalCount)
    ) {
      return repositories
    }
  }

  throw new Error(
    [
      'GitHub returned more than',
      `${maximumPages * pageSize} user-accessible repositories`,
      `for installation ${installationId}`,
    ].join(' '),
  )
}

export function getGitHubErrorStatus(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const status = value.status

  return typeof status === 'number' ? status : undefined
}

async function listRepositories(
  loadPage: (page: number) => Promise<{
    readonly totalCount: number | undefined
    readonly repositories: readonly GitHubInstallationRepository[]
  }>,
): Promise<readonly GitHubInstallationRepository[]> {
  const repositories: GitHubInstallationRepository[] = []
  let totalCount: number | undefined

  for (let page = 1; page <= maximumPages; page += 1) {
    const parsed = await loadPage(page)

    totalCount ??= parsed.totalCount
    repositories.push(...parsed.repositories)

    if (
      parsed.repositories.length < pageSize ||
      (totalCount !== undefined && repositories.length >= totalCount)
    ) {
      return repositories
    }
  }

  throw new Error(`GitHub returned more than ${maximumPages * pageSize} installation repositories`)
}

function parseInstallationMetadata(value: unknown): GitHubInstallationMetadata {
  if (!isRecord(value) || !isRecord(value.account)) {
    throw new Error('GitHub installation metadata response is invalid')
  }

  const installationId = getPositiveInteger(value.id)
  const ownerId = getPositiveInteger(value.account.id)
  const ownerLogin = getNonEmptyString(value.account.login)
  const ownerType = getNonEmptyString(value.target_type) ?? getNonEmptyString(value.account.type)
  const repositorySelection = value.repository_selection

  if (
    installationId === undefined ||
    ownerId === undefined ||
    ownerLogin === undefined ||
    ownerType === undefined ||
    (repositorySelection !== 'all' && repositorySelection !== 'selected')
  ) {
    throw new Error('GitHub installation metadata is missing stable identity fields')
  }

  const summary: GitHubInstallationSummary = {
    id: installationId,
    account: {
      id: ownerId,
      login: ownerLogin,
      type: ownerType,
      avatarUrl: getNullableString(value.account.avatar_url),
    },
    repositorySelection,
    permissions: getStringRecord(value.permissions),
    suspendedAt: getNullableString(value.suspended_at),
  }

  return {
    summary,
    permissions: summary.permissions,
  }
}

function parseRepositoryPage(
  value: unknown,
  endpoint: string,
): {
  readonly totalCount: number | undefined
  readonly repositories: readonly GitHubInstallationRepository[]
} {
  if (!isRecord(value) || !Array.isArray(value.repositories)) {
    throw new Error(`GitHub ${endpoint} returned an invalid response body`)
  }

  return {
    totalCount: getNonNegativeInteger(value.total_count),
    repositories: value.repositories.map(parseRepository),
  }
}

function parseUserRepositoryPage(value: unknown): {
  readonly totalCount: number | undefined
  readonly repositories: readonly GitHubUserRepositoryAccess[]
} {
  const page = parseRepositoryPage(value, 'GET /user/installations/{installation_id}/repositories')

  if (!isRecord(value) || !Array.isArray(value.repositories)) {
    throw new Error('GitHub user installation repositories response is invalid')
  }

  return {
    totalCount: page.totalCount,
    repositories: value.repositories.map((item) => ({
      repository: parseRepository(item),
      permission: parseRepositoryPermission(item),
    })),
  }
}

function parseRepository(value: unknown): GitHubInstallationRepository {
  if (!isRecord(value) || !isRecord(value.owner)) {
    throw new Error('GitHub repository response is invalid')
  }

  const id = getPositiveInteger(value.id)
  const ownerId = getPositiveInteger(value.owner.id)
  const ownerLogin = getNonEmptyString(value.owner.login)
  const name = getNonEmptyString(value.name)
  const fullName = getNonEmptyString(value.full_name)

  if (
    id === undefined ||
    ownerId === undefined ||
    ownerLogin === undefined ||
    name === undefined ||
    fullName === undefined ||
    typeof value.private !== 'boolean'
  ) {
    throw new Error('GitHub repository response is missing stable identity fields')
  }

  return {
    id,
    ownerId,
    ownerLogin,
    name,
    fullName,
    private: value.private,
    archived: value.archived === true,
    disabled: value.disabled === true,
    defaultBranch: getNullableString(value.default_branch),
    visibility: getNullableString(value.visibility),
  }
}

function parseRepositoryPermission(value: unknown): GitHubRepositoryPermission {
  if (!isRecord(value) || !isRecord(value.permissions)) {
    return 'none'
  }

  const permissions = value.permissions

  if (permissions.admin === true) {
    return 'admin'
  }

  if (permissions.maintain === true) {
    return 'maintain'
  }

  if (permissions.push === true) {
    return 'write'
  }

  if (permissions.triage === true) {
    return 'triage'
  }

  return permissions.pull === true ? 'read' : 'none'
}

function getStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    return {}
  }

  const result: Record<string, string> = {}

  for (const [name, level] of Object.entries(value)) {
    if (typeof level === 'string') {
      result[name] = level
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
