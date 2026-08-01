import type { JsonValue } from '@shipgate/database'

export interface GitHubInstallationAccount {
  readonly id: number
  readonly login: string
  readonly type: string
  readonly avatarUrl: string | null
}

export interface GitHubInstallationSummary {
  readonly id: number
  readonly account: GitHubInstallationAccount
  readonly repositorySelection: 'all' | 'selected'
  readonly permissions: Readonly<Record<string, string>>
  readonly suspendedAt: string | null
}

export interface GitHubUserIdentity {
  readonly githubUserId: number
  readonly login: string
  readonly avatarUrl: string | null
  readonly displayName: string | null
  readonly email: string | null
  readonly htmlUrl: string
  readonly installations: readonly GitHubInstallationSummary[]
}

export interface AuthenticatedSession {
  readonly id: string
  readonly githubUserId: number
  readonly csrfTokenHash: string
  readonly expiresAt: Date
  readonly user: GitHubUserIdentity
}

export function serializeInstallations(
  installations: readonly GitHubInstallationSummary[],
): JsonValue {
  return installations.map((installation) => ({
    id: installation.id,
    account: {
      id: installation.account.id,
      login: installation.account.login,
      type: installation.account.type,
      avatarUrl: installation.account.avatarUrl,
    },
    repositorySelection: installation.repositorySelection,
    permissions: installation.permissions,
    suspendedAt: installation.suspendedAt,
  }))
}

export function parseInstallations(value: JsonValue): readonly GitHubInstallationSummary[] {
  if (!Array.isArray(value)) {
    return []
  }

  const installations: GitHubInstallationSummary[] = []

  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }

    const id = getPositiveInteger(item.id)
    const account = isRecord(item.account) ? item.account : undefined
    const accountId = account ? getPositiveInteger(account.id) : undefined
    const login = account ? getString(account.login) : undefined
    const type = account ? getString(account.type) : undefined
    const repositorySelection = item.repositorySelection

    if (
      id === undefined ||
      accountId === undefined ||
      login === undefined ||
      type === undefined ||
      (repositorySelection !== 'all' && repositorySelection !== 'selected')
    ) {
      continue
    }

    installations.push({
      id,
      account: {
        id: accountId,
        login,
        type,
        avatarUrl:
          account && (account.avatarUrl === null || typeof account.avatarUrl === 'string')
            ? account.avatarUrl
            : null,
      },
      repositorySelection,
      permissions: parseStringRecord(item.permissions),
      suspendedAt:
        item.suspendedAt === null || typeof item.suspendedAt === 'string' ? item.suspendedAt : null,
    })
  }

  return installations
}

function parseStringRecord(value: JsonValue | undefined): Readonly<Record<string, string>> {
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

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getPositiveInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function getString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
