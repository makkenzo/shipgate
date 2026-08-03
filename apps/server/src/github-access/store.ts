import type { DatabaseClient, GitHubInstallationPermissionState } from '@shipgate/database'

import type { ReconciledInstallationAccess } from './model.js'

export async function replaceGitHubInstallationSnapshot(
  database: DatabaseClient,
  snapshot: ReconciledInstallationAccess,
  options: {
    readonly replaceRepositories?: boolean
    readonly permissionState?: GitHubInstallationPermissionState
    readonly githubUserId?: number
    readonly replaceUserRepositories?: boolean
  } = {},
): Promise<void> {
  const { installation, reconciledAt, repositories, userRepositories } = snapshot
  const summary = installation.summary
  const installationId = serializeGitHubId(summary.id, 'installation ID')
  const githubUserId =
    options.githubUserId === undefined
      ? undefined
      : serializeGitHubId(options.githubUserId, 'GitHub user ID')
  const permissionState: GitHubInstallationPermissionState =
    options.permissionState ?? (summary.suspendedAt === null ? 'current' : 'suspended')

  await database.kysely.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('github_installations')
      .values({
        installation_id: installationId,
        owner_id: serializeGitHubId(summary.account.id, 'installation owner ID'),
        owner_type: summary.account.type,
        owner_login: summary.account.login,
        owner_avatar_url: summary.account.avatarUrl,
        repository_selection: summary.repositorySelection,
        suspended_at: parseNullableDate(summary.suspendedAt, 'installation suspended_at'),
        permission_state: permissionState,
        lifecycle_state: summary.suspendedAt === null ? 'active' : 'suspended',
        deletion_requested_at: null,
        deleted_at: null,
        last_successful_confirmation_at: reconciledAt,
        last_reconciled_at: reconciledAt,
        updated_at: reconciledAt,
      })
      .onConflict((conflict) =>
        conflict.column('installation_id').doUpdateSet({
          owner_id: serializeGitHubId(summary.account.id, 'installation owner ID'),
          owner_type: summary.account.type,
          owner_login: summary.account.login,
          owner_avatar_url: summary.account.avatarUrl,
          repository_selection: summary.repositorySelection,
          suspended_at: parseNullableDate(summary.suspendedAt, 'installation suspended_at'),
          permission_state: permissionState,
          lifecycle_state: summary.suspendedAt === null ? 'active' : 'suspended',
          deletion_requested_at: null,
          deleted_at: null,
          last_successful_confirmation_at: reconciledAt,
          last_reconciled_at: reconciledAt,
          updated_at: reconciledAt,
        }),
      )
      .execute()

    await transaction
      .deleteFrom('github_installation_permissions')
      .where('installation_id', '=', installationId)
      .execute()

    const permissions = Object.entries(
      installation.permissions as Readonly<Record<string, string>>,
    ).map(([name, level]) => ({
      installation_id: installationId,
      permission_name: name,
      permission_level: parsePermissionLevel(level),
      last_reconciled_at: reconciledAt,
      updated_at: reconciledAt,
    }))

    if (permissions.length > 0) {
      await transaction.insertInto('github_installation_permissions').values(permissions).execute()
    }

    if (options.replaceRepositories !== false) {
      await transaction
        .deleteFrom('github_installation_repositories')
        .where('installation_id', '=', installationId)
        .execute()

      if (repositories.length > 0) {
        await transaction
          .insertInto('github_installation_repositories')
          .values(
            repositories.map((repository) => ({
              installation_id: installationId,
              repository_id: serializeGitHubId(repository.id, 'repository ID'),
              owner_id: serializeGitHubId(repository.ownerId, 'repository owner ID'),
              owner_login: repository.ownerLogin,
              name: repository.name,
              full_name: repository.fullName,
              private: repository.private,
              archived: repository.archived,
              disabled: repository.disabled,
              default_branch: repository.defaultBranch,
              visibility: repository.visibility,
              last_successful_confirmation_at: reconciledAt,
              last_reconciled_at: reconciledAt,
              updated_at: reconciledAt,
            })),
          )
          .execute()
      }
    }

    if (githubUserId !== undefined) {
      await transaction
        .insertInto('github_user_installations')
        .values({
          github_user_id: githubUserId,
          installation_id: installationId,
          last_reconciled_at: reconciledAt,
          updated_at: reconciledAt,
        })
        .onConflict((conflict) =>
          conflict.columns(['github_user_id', 'installation_id']).doUpdateSet({
            last_reconciled_at: reconciledAt,
            updated_at: reconciledAt,
          }),
        )
        .execute()

      if (options.replaceUserRepositories !== false) {
        await transaction
          .deleteFrom('github_user_installation_repositories')
          .where('github_user_id', '=', githubUserId)
          .where('installation_id', '=', installationId)
          .execute()

        const userRepositoryRows = userRepositories
          .filter((access) => access.permission !== 'none')
          .map((access) => ({
            github_user_id: githubUserId,
            installation_id: installationId,
            repository_id: serializeGitHubId(access.repository.id, 'repository ID'),
            repository_permission: assertStoredRepositoryPermission(access.permission),
            last_reconciled_at: reconciledAt,
            updated_at: reconciledAt,
          }))

        if (userRepositoryRows.length > 0) {
          await transaction
            .insertInto('github_user_installation_repositories')
            .values(userRepositoryRows)
            .execute()
        }
      }
    }
  })
}

export async function removeGitHubUserInstallationAccess(input: {
  readonly database: DatabaseClient
  readonly githubUserId: number
  readonly installationId: number
}): Promise<void> {
  await input.database.kysely
    .deleteFrom('github_user_installations')
    .where('github_user_id', '=', serializeGitHubId(input.githubUserId, 'GitHub user ID'))
    .where('installation_id', '=', serializeGitHubId(input.installationId, 'installation ID'))
    .execute()
}

export async function pruneGitHubUserInstallations(input: {
  readonly database: DatabaseClient
  readonly githubUserId: number
  readonly installationIds: readonly number[]
}): Promise<void> {
  const githubUserId = serializeGitHubId(input.githubUserId, 'GitHub user ID')
  let query = input.database.kysely
    .deleteFrom('github_user_installations')
    .where('github_user_id', '=', githubUserId)

  if (input.installationIds.length > 0) {
    query = query.where(
      'installation_id',
      'not in',
      input.installationIds.map((installationId) =>
        serializeGitHubId(installationId, 'installation ID'),
      ),
    )
  }

  await query.execute()
}

export async function markGitHubInstallationPermissionState(input: {
  readonly database: DatabaseClient
  readonly installationId: number
  readonly state: GitHubInstallationPermissionState
  readonly reconciledAt: Date
}): Promise<void> {
  await input.database.kysely
    .updateTable('github_installations')
    .set({
      permission_state: input.state,
      last_reconciled_at: input.reconciledAt,
      updated_at: input.reconciledAt,
    })
    .where('installation_id', '=', serializeGitHubId(input.installationId, 'installation ID'))
    .execute()
}

function parsePermissionLevel(value: string): 'read' | 'write' {
  if (value === 'read' || value === 'write') {
    return value
  }

  throw new Error(`GitHub installation returned unsupported permission level: ${value}`)
}

function assertStoredRepositoryPermission(
  value: string,
): 'read' | 'triage' | 'write' | 'maintain' | 'admin' {
  if (
    value === 'read' ||
    value === 'triage' ||
    value === 'write' ||
    value === 'maintain' ||
    value === 'admin'
  ) {
    return value
  }

  throw new Error(`GitHub user repository permission cannot be stored: ${value}`)
}

function parseNullableDate(value: string | null, name: string): Date | null {
  if (value === null) {
    return null
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new Error(`GitHub ${name} is invalid: ${value}`)
  }

  return date
}

function serializeGitHubId(value: number, name: string): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }

  return String(value)
}
