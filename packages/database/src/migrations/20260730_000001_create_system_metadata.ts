import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .createTable('shipgate_system_metadata')
    .addColumn('key', 'text', (column) => column.primaryKey())
    .addColumn('value', 'jsonb', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .execute()

  await sql`
    insert into shipgate_system_metadata (
      key,
      value
    )
    values (
      'migration_infrastructure',
      '{"status":"ready"}'::jsonb
    )
  `.execute(database)
}

export const down: Migration['down'] = async (database) => {
  await database.schema.dropTable('shipgate_system_metadata').execute()
}
