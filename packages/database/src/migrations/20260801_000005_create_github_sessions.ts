import { sql, type SqlBool } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .alterTable('shipgate_github_user_credential')
    .renameTo('github_user_credentials')
    .execute()

  await database.schema
    .createTable('github_users')
    .addColumn('github_user_id', 'text', (column) => column.primaryKey())
    .addColumn('login', 'text', (column) => column.notNull())
    .addColumn('avatar_url', 'text')
    .addColumn('display_name', 'text')
    .addColumn('email', 'text')
    .addColumn('html_url', 'text', (column) => column.notNull())
    .addColumn('installations', 'jsonb', (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('installations_synced_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .execute()

  await database.schema
    .createTable('sessions')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('github_user_id', 'text', (column) =>
      column.notNull().references('github_user_credentials.github_user_id').onDelete('cascade'),
    )
    .addColumn('token_hash', 'text', (column) => column.notNull().unique())
    .addColumn('csrf_token_hash', 'text', (column) => column.notNull())
    .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('revocation_reason', 'text')
    .addColumn('last_seen_at', 'timestamptz', (column) => column.notNull())
    .addColumn('user_agent', 'text')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('sessions_token_hash_check', sql`length(token_hash) = 64`)
    .addCheckConstraint('sessions_csrf_token_hash_check', sql`length(csrf_token_hash) = 64`)
    .addCheckConstraint(
      'sessions_revocation_check',
      sql`
        (revoked_at is null and revocation_reason is null)
        or
        (revoked_at is not null and revocation_reason is not null)
      `,
    )
    .execute()

  await database.schema
    .createIndex('sessions_active_token_idx')
    .on('sessions')
    .column('token_hash')
    .where(sql<SqlBool>`revoked_at is null`)
    .execute()

  await database.schema
    .createIndex('sessions_user_idx')
    .on('sessions')
    .columns(['github_user_id', 'expires_at'])
    .execute()

  await database.schema
    .createIndex('sessions_expiry_idx')
    .on('sessions')
    .column('expires_at')
    .execute()

  await database.schema
    .createTable('oauth_attempts')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('state_hash', 'text', (column) => column.notNull().unique())
    .addColumn('pkce_verifier', 'text', (column) => column.notNull())
    .addColumn('return_to', 'text', (column) => column.notNull())
    .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
    .addColumn('consumed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('oauth_attempts_state_hash_check', sql`length(state_hash) = 64`)
    .addCheckConstraint(
      'oauth_attempts_pkce_verifier_check',
      sql`length(pkce_verifier) between 43 and 128`,
    )
    .execute()

  await database.schema
    .createIndex('oauth_attempts_expiry_idx')
    .on('oauth_attempts')
    .column('expires_at')
    .execute()
}

export const down: Migration['down'] = async (database) => {
  await database.schema.dropTable('oauth_attempts').execute()
  await database.schema.dropTable('sessions').execute()

  await database.schema.dropTable('github_users').execute()

  await database.schema
    .alterTable('github_user_credentials')
    .renameTo('shipgate_github_user_credential')
    .execute()
}
