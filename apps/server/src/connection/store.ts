import type {
  DatabaseClient,
  GitHubInstallationLifecycleState,
  GitHubInstallationPermissionState,
  GitHubRepositoryPermission,
} from '@shipgate/database'
import {
  GITHUB_APP_REPOSITORY_PERMISSIONS,
  type InstallationPermissionLevel,
  type InstallationPermissionName,
} from '@shipgate/github'

export interface ConnectionPermissionStatus {
  readonly name: InstallationPermissionName
  readonly required: InstallationPermissionLevel
  readonly actual: InstallationPermissionLevel | null
  readonly satisfied: boolean
}

export interface ConnectionInstallationSummary {
  readonly id: number
  readonly owner: {
    readonly id: number
    readonly login: string
    readonly type: string
    readonly avatarUrl: string | null
  }
  readonly repositorySelection: 'all' | 'selected'
  readonly lifecycleState: GitHubInstallationLifecycleState
  readonly permissionState: GitHubInstallationPermissionState
  readonly suspendedAt: string | null
  readonly repositoryCount: number
  readonly userRepositoryCount: number
  readonly permissions: readonly ConnectionPermissionStatus[]
  readonly permissionUpgradePending: boolean
  readonly lastReconciledAt: string
}

export interface ConnectionRepository {
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
  readonly userPermission: GitHubRepositoryPermission
  readonly accessibleToUser: boolean
  readonly lastReconciledAt: string
}

export interface ConnectionInstallationDetail extends ConnectionInstallationSummary {
  readonly repositories: readonly ConnectionRepository[]
}

export async function listConnectionInstallations(
  database: DatabaseClient,
  githubUserId: number,
): Promise<readonly ConnectionInstallationSummary[]> {
  const serializedUserId = serializeGitHubId(githubUserId, 'GitHub user ID')
  const rows = await database.kysely
    .selectFrom('github_user_installations as user_installation')
    .innerJoin(
      'github_installations as installation',
      'installation.installation_id',
      'user_installation.installation_id',
    )
    .select([
      'installation.installation_id',
      'installation.owner_id',
      'installation.owner_login',
      'installation.owner_type',
      'installation.owner_avatar_url',
      'installation.repository_selection',
      'installation.lifecycle_state',
      'installation.permission_state',
      'installation.suspended_at',
      'installation.last_reconciled_at',
    ])
    .where('user_installation.github_user_id', '=', serializedUserId)
    .orderBy('installation.owner_login')
    .execute()

  if (rows.length === 0) {
    return []
  }

  const installationIds = rows.map((row) => row.installation_id)
  const [permissionRows, repositoryRows, userRepositoryRows] = await Promise.all([
    database.kysely
      .selectFrom('github_installation_permissions')
      .select(['installation_id', 'permission_name', 'permission_level'])
      .where('installation_id', 'in', installationIds)
      .execute(),
    database.kysely
      .selectFrom('github_installation_repositories')
      .select('installation_id')
      .where('installation_id', 'in', installationIds)
      .execute(),
    database.kysely
      .selectFrom('github_user_installation_repositories')
      .select('installation_id')
      .where('github_user_id', '=', serializedUserId)
      .where('installation_id', 'in', installationIds)
      .execute(),
  ])

  const permissions = groupPermissions(permissionRows)
  const repositoryCounts = countByInstallation(repositoryRows)
  const userRepositoryCounts = countByInstallation(userRepositoryRows)

  return rows.map((row) =>
    mapInstallationSummary(
      row,
      permissions.get(row.installation_id) ?? new Map(),
      repositoryCounts.get(row.installation_id) ?? 0,
      userRepositoryCounts.get(row.installation_id) ?? 0,
    ),
  )
}

export async function getConnectionInstallation(
  database: DatabaseClient,
  githubUserId: number,
  installationId: number,
): Promise<ConnectionInstallationDetail | undefined> {
  const serializedUserId = serializeGitHubId(githubUserId, 'GitHub user ID')
  const serializedInstallationId = serializeGitHubId(installationId, 'installation ID')
  const installation = await database.kysely
    .selectFrom('github_user_installations as user_installation')
    .innerJoin(
      'github_installations as installation',
      'installation.installation_id',
      'user_installation.installation_id',
    )
    .select([
      'installation.installation_id',
      'installation.owner_id',
      'installation.owner_login',
      'installation.owner_type',
      'installation.owner_avatar_url',
      'installation.repository_selection',
      'installation.lifecycle_state',
      'installation.permission_state',
      'installation.suspended_at',
      'installation.last_reconciled_at',
    ])
    .where('user_installation.github_user_id', '=', serializedUserId)
    .where('user_installation.installation_id', '=', serializedInstallationId)
    .executeTakeFirst()

  if (!installation) {
    return undefined
  }

  const [permissionRows, repositoryRows] = await Promise.all([
    database.kysely
      .selectFrom('github_installation_permissions')
      .select(['permission_name', 'permission_level'])
      .where('installation_id', '=', serializedInstallationId)
      .execute(),
    database.kysely
      .selectFrom('github_installation_repositories as repository')
      .leftJoin('github_user_installation_repositories as user_access', (join) =>
        join
          .onRef('user_access.installation_id', '=', 'repository.installation_id')
          .onRef('user_access.repository_id', '=', 'repository.repository_id')
          .on('user_access.github_user_id', '=', serializedUserId),
      )
      .select([
        'repository.repository_id',
        'repository.owner_id',
        'repository.owner_login',
        'repository.name',
        'repository.full_name',
        'repository.private',
        'repository.archived',
        'repository.disabled',
        'repository.default_branch',
        'repository.visibility',
        'repository.last_reconciled_at',
        'user_access.repository_permission',
      ])
      .where('repository.installation_id', '=', serializedInstallationId)
      .orderBy('repository.full_name')
      .execute(),
  ])

  const permissionMap = new Map<string, InstallationPermissionLevel>(
    permissionRows.map((row) => [row.permission_name, row.permission_level] as const),
  )
  const repositories = repositoryRows.map((row): ConnectionRepository => {
    const userPermission = row.repository_permission ?? 'none'

    return {
      id: parseGitHubId(row.repository_id, 'repository ID'),
      ownerId: parseGitHubId(row.owner_id, 'repository owner ID'),
      ownerLogin: row.owner_login,
      name: row.name,
      fullName: row.full_name,
      private: row.private,
      archived: row.archived,
      disabled: row.disabled,
      defaultBranch: row.default_branch,
      visibility: row.visibility,
      userPermission,
      accessibleToUser: userPermission !== 'none',
      lastReconciledAt: row.last_reconciled_at.toISOString(),
    }
  })
  const summary = mapInstallationSummary(
    installation,
    permissionMap,
    repositories.length,
    repositories.filter((repository) => repository.accessibleToUser).length,
  )

  return {
    ...summary,
    repositories,
  }
}

export async function deleteLocalAccount(
  database: DatabaseClient,
  githubUserId: number,
): Promise<void> {
  const serializedUserId = serializeGitHubId(githubUserId, 'GitHub user ID')

  await database.kysely.transaction().execute(async (transaction) => {
    await transaction
      .deleteFrom('github_user_credentials')
      .where('github_user_id', '=', serializedUserId)
      .execute()
    await transaction
      .deleteFrom('github_users')
      .where('github_user_id', '=', serializedUserId)
      .execute()
  })
}

type InstallationRow = {
  readonly installation_id: string
  readonly owner_id: string
  readonly owner_login: string
  readonly owner_type: string
  readonly owner_avatar_url: string | null
  readonly repository_selection: 'all' | 'selected'
  readonly lifecycle_state: GitHubInstallationLifecycleState
  readonly permission_state: GitHubInstallationPermissionState
  readonly suspended_at: Date | null
  readonly last_reconciled_at: Date
}

function mapInstallationSummary(
  row: InstallationRow,
  actualPermissions: ReadonlyMap<string, InstallationPermissionLevel>,
  repositoryCount: number,
  userRepositoryCount: number,
): ConnectionInstallationSummary {
  const permissions = getPermissionStatus(actualPermissions)

  return {
    id: parseGitHubId(row.installation_id, 'installation ID'),
    owner: {
      id: parseGitHubId(row.owner_id, 'installation owner ID'),
      login: row.owner_login,
      type: row.owner_type,
      avatarUrl: row.owner_avatar_url,
    },
    repositorySelection: row.repository_selection,
    lifecycleState: row.lifecycle_state,
    permissionState: row.permission_state,
    suspendedAt: row.suspended_at?.toISOString() ?? null,
    repositoryCount,
    userRepositoryCount,
    permissions,
    permissionUpgradePending: permissions.some((permission) => !permission.satisfied),
    lastReconciledAt: row.last_reconciled_at.toISOString(),
  }
}

function getPermissionStatus(
  actualPermissions: ReadonlyMap<string, InstallationPermissionLevel>,
): readonly ConnectionPermissionStatus[] {
  return Object.entries(GITHUB_APP_REPOSITORY_PERMISSIONS).map(([name, required]) => {
    const permissionName = name as InstallationPermissionName
    const actual = actualPermissions.get(permissionName) ?? null

    return {
      name: permissionName,
      required,
      actual,
      satisfied: actual === 'write' || (required === 'read' && actual === 'read'),
    }
  })
}

function groupPermissions(
  rows: readonly {
    readonly installation_id: string
    readonly permission_name: string
    readonly permission_level: InstallationPermissionLevel
  }[],
): Map<string, Map<string, InstallationPermissionLevel>> {
  const grouped = new Map<string, Map<string, InstallationPermissionLevel>>()

  for (const row of rows) {
    const permissions = grouped.get(row.installation_id) ?? new Map()
    permissions.set(row.permission_name, row.permission_level)
    grouped.set(row.installation_id, permissions)
  }

  return grouped
}

function countByInstallation(
  rows: readonly { readonly installation_id: string }[],
): Map<string, number> {
  const counts = new Map<string, number>()

  for (const row of rows) {
    counts.set(row.installation_id, (counts.get(row.installation_id) ?? 0) + 1)
  }

  return counts
}

function serializeGitHubId(value: number, name: string): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }

  return String(value)
}

function parseGitHubId(value: string, name: string): number {
  const id = Number(value)

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Stored GitHub ${name} is invalid: ${value}`)
  }

  return id
}
