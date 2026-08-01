import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .createTable('github_installations')
    .addColumn('installation_id', 'text', (column) => column.primaryKey())
    .addColumn('owner_id', 'text', (column) => column.notNull())
    .addColumn('owner_type', 'text', (column) => column.notNull())
    .addColumn('owner_login', 'text', (column) => column.notNull())
    .addColumn('owner_avatar_url', 'text')
    .addColumn('repository_selection', 'text', (column) => column.notNull())
    .addColumn('suspended_at', 'timestamptz')
    .addColumn('permission_state', 'text', (column) => column.notNull().defaultTo('stale'))
    .addColumn('last_successful_confirmation_at', 'timestamptz')
    .addColumn('last_reconciled_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'github_installations_repository_selection_check',
      sql`repository_selection in ('all', 'selected')`,
    )
    .addCheckConstraint(
      'github_installations_permission_state_check',
      sql`permission_state in ('current', 'stale', 'suspended', 'revoked')`,
    )
    .execute()

  await database.schema
    .createIndex('github_installations_owner_idx')
    .on('github_installations')
    .columns(['owner_type', 'owner_id'])
    .execute()

  await database.schema
    .createIndex('github_installations_reconciled_idx')
    .on('github_installations')
    .column('last_reconciled_at')
    .execute()

  await database.schema
    .createTable('github_installation_repositories')
    .addColumn('installation_id', 'text', (column) =>
      column.notNull().references('github_installations.installation_id').onDelete('cascade'),
    )
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('owner_id', 'text', (column) => column.notNull())
    .addColumn('owner_login', 'text', (column) => column.notNull())
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('full_name', 'text', (column) => column.notNull())
    .addColumn('private', 'boolean', (column) => column.notNull())
    .addColumn('archived', 'boolean', (column) => column.notNull())
    .addColumn('disabled', 'boolean', (column) => column.notNull())
    .addColumn('default_branch', 'text')
    .addColumn('visibility', 'text')
    .addColumn('last_successful_confirmation_at', 'timestamptz', (column) => column.notNull())
    .addColumn('last_reconciled_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('github_installation_repositories_pkey', [
      'installation_id',
      'repository_id',
    ])
    .execute()

  await database.schema
    .createIndex('github_installation_repositories_repository_idx')
    .on('github_installation_repositories')
    .column('repository_id')
    .execute()

  await database.schema
    .createIndex('github_installation_repositories_full_name_idx')
    .on('github_installation_repositories')
    .column('full_name')
    .execute()

  await database.schema
    .createTable('github_installation_permissions')
    .addColumn('installation_id', 'text', (column) =>
      column.notNull().references('github_installations.installation_id').onDelete('cascade'),
    )
    .addColumn('permission_name', 'text', (column) => column.notNull())
    .addColumn('permission_level', 'text', (column) => column.notNull())
    .addColumn('last_reconciled_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('github_installation_permissions_pkey', [
      'installation_id',
      'permission_name',
    ])
    .addCheckConstraint(
      'github_installation_permissions_level_check',
      sql`permission_level in ('read', 'write')`,
    )
    .execute()
}

export const down: Migration['down'] = async (database) => {
  await database.schema.dropTable('github_installation_permissions').execute()
  await database.schema.dropTable('github_installation_repositories').execute()
  await database.schema.dropTable('github_installations').execute()
}
