import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .createTable('github_user_installations')
    .addColumn('github_user_id', 'text', (column) =>
      column.notNull().references('github_user_credentials.github_user_id').onDelete('cascade'),
    )
    .addColumn('installation_id', 'text', (column) =>
      column.notNull().references('github_installations.installation_id').onDelete('cascade'),
    )
    .addColumn('last_reconciled_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('github_user_installations_pkey', [
      'github_user_id',
      'installation_id',
    ])
    .execute()

  await database.schema
    .createIndex('github_user_installations_installation_idx')
    .on('github_user_installations')
    .column('installation_id')
    .execute()

  await database.schema
    .createTable('github_user_installation_repositories')
    .addColumn('github_user_id', 'text', (column) =>
      column.notNull().references('github_user_credentials.github_user_id').onDelete('cascade'),
    )
    .addColumn('installation_id', 'text', (column) =>
      column.notNull().references('github_installations.installation_id').onDelete('cascade'),
    )
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('repository_permission', 'text', (column) => column.notNull())
    .addColumn('last_reconciled_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('github_user_installation_repositories_pkey', [
      'github_user_id',
      'installation_id',
      'repository_id',
    ])
    .addCheckConstraint(
      'github_user_installation_repositories_permission_check',
      sql`repository_permission in ('read', 'triage', 'write', 'maintain', 'admin')`,
    )
    .execute()

  await sql`
    alter table github_user_installation_repositories
    add constraint github_user_installation_repositories_repository_fkey
    foreign key (installation_id, repository_id)
    references github_installation_repositories (installation_id, repository_id)
    on delete cascade
  `.execute(database)

  await sql`
    alter table github_user_installation_repositories
    add constraint github_user_installation_repositories_user_installation_fkey
    foreign key (github_user_id, installation_id)
    references github_user_installations (github_user_id, installation_id)
    on delete cascade
  `.execute(database)

  await database.schema
    .createIndex('github_user_installation_repositories_repository_idx')
    .on('github_user_installation_repositories')
    .columns(['github_user_id', 'repository_id'])
    .execute()
}

export const down: Migration['down'] = async (database) => {
  await database.schema.dropTable('github_user_installation_repositories').execute()
  await database.schema.dropTable('github_user_installations').execute()
}
