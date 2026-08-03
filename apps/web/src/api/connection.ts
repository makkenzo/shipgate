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

export type AuthSession =
  | { readonly authenticated: false }
  | {
      readonly authenticated: true
      readonly session: {
        readonly id: string
        readonly expiresAt: string
      }
      readonly user: {
        readonly id: number
        readonly login: string
        readonly avatarUrl: string | null
        readonly displayName: string | null
        readonly email: string | null
        readonly htmlUrl: string
        readonly installations: readonly GitHubInstallationSummary[]
      }
    }

export interface ConnectionConfiguration {
  readonly githubLoginConfigured: boolean
  readonly githubInstallationConfigured: boolean
  readonly loginUrl: string
  readonly installUrl: string | null
}

export interface InstallationPermissionStatus {
  readonly name: string
  readonly required: 'read' | 'write'
  readonly actual: 'read' | 'write' | null
  readonly satisfied: boolean
}

export interface InstallationSummary {
  readonly id: number
  readonly owner: GitHubInstallationAccount
  readonly repositorySelection: 'all' | 'selected'
  readonly lifecycleState: 'active' | 'suspended' | 'pending_deletion' | 'deleted'
  readonly permissionState: 'current' | 'stale' | 'suspended' | 'revoked'
  readonly suspendedAt: string | null
  readonly repositoryCount: number
  readonly userRepositoryCount: number
  readonly permissions: readonly InstallationPermissionStatus[]
  readonly permissionUpgradePending: boolean
  readonly lastReconciledAt: string
}

export interface InstallationRepository {
  readonly id: number
  readonly ownerId: number
  readonly ownerLogin: string
  readonly name: string
  readonly fullName: string
  readonly private: boolean
  readonly archived: boolean
  readonly disabled: boolean
  readonly defaultBranch: string | null
  readonly visibility: string | null
  readonly userPermission: 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin'
  readonly accessibleToUser: boolean
  readonly lastReconciledAt: string
}

export interface InstallationDetail extends InstallationSummary {
  readonly repositories: readonly InstallationRepository[]
  readonly manageUrl: string
}

export async function getAuthSession(): Promise<AuthSession> {
  return requestJson('/api/v1/auth/session')
}

export async function getConnectionConfiguration(): Promise<ConnectionConfiguration> {
  return requestJson('/api/v1/connection')
}

export async function getInstallations(): Promise<readonly InstallationSummary[]> {
  const response = await requestJson<{ readonly installations: readonly InstallationSummary[] }>(
    '/api/v1/installations',
  )

  return response.installations
}

export async function getInstallation(installationId: number): Promise<InstallationDetail> {
  return requestJson(`/api/v1/installations/${encodeURIComponent(String(installationId))}`)
}

export async function logout(): Promise<void> {
  await mutate('/api/v1/auth/logout', 'POST')
}

export async function disconnectGitHub(): Promise<void> {
  await mutate('/api/v1/auth/disconnect', 'POST')
}

export async function deleteLocalAccount(): Promise<void> {
  await mutate('/api/v1/account', 'DELETE')
}

async function mutate(url: string, method: 'POST' | 'DELETE'): Promise<void> {
  const csrfToken = readCookie('__Host-shipgate_csrf')
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-csrf-token': csrfToken ?? '',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
  })

  await ensureSuccess(response)
}

async function requestJson<Value>(url: string): Promise<Value> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
    },
  })

  await ensureSuccess(response)

  return (await response.json()) as Value
}

async function ensureSuccess(response: Response): Promise<void> {
  if (response.ok) {
    return
  }

  const contentType = response.headers.get('content-type')

  if (contentType?.includes('application/json')) {
    throw (await response.json()) as unknown
  }

  throw new Error(`Shipgate API returned HTTP ${response.status}`)
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') {
    return undefined
  }

  const prefix = `${name}=`

  for (const part of document.cookie.split(';')) {
    const cookie = part.trim()

    if (cookie.startsWith(prefix)) {
      return decodeURIComponent(cookie.slice(prefix.length))
    }
  }

  return undefined
}
