import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .createTable('shipgate_github_user_credential')
    .addColumn('github_user_id', 'text', (column) => column.primaryKey())
    .addColumn('version', 'integer', (column) => column.notNull().defaultTo(1))
    .addColumn('encrypted_access_token', 'text', (column) => column.notNull())
    .addColumn('access_token_expires_at', 'timestamptz', (column) => column.notNull())
    .addColumn('encrypted_refresh_token', 'text', (column) => column.notNull())
    .addColumn('refresh_token_expires_at', 'timestamptz', (column) => column.notNull())
    .addColumn('refresh_lease_id', 'text')
    .addColumn('refresh_lease_expires_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('shipgate_github_user_credential_version_check', sql`version > 0`)
    .addCheckConstraint(
      'shipgate_github_user_credential_refresh_lease_check',
      sql`
        (
          refresh_lease_id is null
          and refresh_lease_expires_at is null
        )
        or
        (
          refresh_lease_id is not null
          and refresh_lease_expires_at is not null
        )
      `,
    )
    .execute()

  await database.schema
    .createIndex('shipgate_github_user_credential_access_expiry_idx')
    .on('shipgate_github_user_credential')
    .column('access_token_expires_at')
    .execute()

  await database.schema
    .createIndex('shipgate_github_user_credential_refresh_expiry_idx')
    .on('shipgate_github_user_credential')
    .column('refresh_token_expires_at')
    .execute()
}

export const down: Migration['down'] = async (database) => {
  await database.schema.dropTable('shipgate_github_user_credential').execute()
}
