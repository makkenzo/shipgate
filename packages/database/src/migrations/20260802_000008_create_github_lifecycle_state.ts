import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .alterTable('github_installations')
    .addColumn('lifecycle_state', 'text', (column) => column.notNull().defaultTo('active'))
    .addColumn('deletion_requested_at', 'timestamptz')
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  await database.schema
    .alterTable('github_installations')
    .addCheckConstraint(
      'github_installations_lifecycle_state_check',
      sql`lifecycle_state in ('active', 'suspended', 'pending_deletion', 'deleted')`,
    )
    .execute()

  await database.schema
    .createTable('github_integration_events')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('event_type', 'text', (column) => column.notNull())
    .addColumn('installation_id', 'text')
    .addColumn('repository_id', 'text')
    .addColumn('github_user_id', 'text')
    .addColumn('payload', 'jsonb', (column) => column.notNull())
    .addColumn('occurred_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .execute()

  await database.schema
    .createIndex('github_integration_events_installation_idx')
    .on('github_integration_events')
    .columns(['installation_id', 'occurred_at'])
    .execute()

  await database.schema
    .createIndex('github_integration_events_repository_idx')
    .on('github_integration_events')
    .columns(['repository_id', 'occurred_at'])
    .execute()
}

export const down: Migration['down'] = async (database) => {
  await database.schema.dropTable('github_integration_events').execute()
  await database.schema
    .alterTable('github_installations')
    .dropConstraint('github_installations_lifecycle_state_check')
    .execute()

  await database.schema.alterTable('github_installations').dropColumn('deleted_at').execute()
  await database.schema
    .alterTable('github_installations')
    .dropColumn('deletion_requested_at')
    .execute()
  await database.schema.alterTable('github_installations').dropColumn('lifecycle_state').execute()
}
