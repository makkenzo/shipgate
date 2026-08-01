import type { DatabaseClient, GitHubInstallationPermissionState } from '@shipgate/database'

import type { ReconciledInstallationAccess } from './model.js'

export async function replaceGitHubInstallationSnapshot(
  database: DatabaseClient,
  snapshot: ReconciledInstallationAccess,
  options: {
    readonly replaceRepositories?: boolean
    readonly permissionState?: GitHubInstallationPermissionState
  } = {},
): Promise<void> {
  const { installation, reconciledAt, repositories } = snapshot
  const summary = installation.summary
  const permissionState: GitHubInstallationPermissionState =
    options.permissionState ?? (summary.suspendedAt === null ? 'current' : 'suspended')

  await database.kysely.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('github_installations')
      .values({
        installation_id: serializeGitHubId(summary.id, 'installation ID'),
        owner_id: serializeGitHubId(summary.account.id, 'installation owner ID'),
        owner_type: summary.account.type,
        owner_login: summary.account.login,
        owner_avatar_url: summary.account.avatarUrl,
        repository_selection: summary.repositorySelection,
        suspended_at: parseNullableDate(summary.suspendedAt, 'installation suspended_at'),
        permission_state: permissionState,
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
          last_successful_confirmation_at: reconciledAt,
          last_reconciled_at: reconciledAt,
          updated_at: reconciledAt,
        }),
      )
      .execute()

    await transaction
      .deleteFrom('github_installation_permissions')
      .where('installation_id', '=', serializeGitHubId(summary.id, 'installation ID'))
      .execute()

    const permissions = Object.entries(installation.permissions).map(([name, level]) => ({
      installation_id: serializeGitHubId(summary.id, 'installation ID'),
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
        .where('installation_id', '=', serializeGitHubId(summary.id, 'installation ID'))
        .execute()

      if (repositories.length > 0) {
        await transaction
          .insertInto('github_installation_repositories')
          .values(
            repositories.map((repository) => ({
              installation_id: serializeGitHubId(summary.id, 'installation ID'),
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
  })
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
