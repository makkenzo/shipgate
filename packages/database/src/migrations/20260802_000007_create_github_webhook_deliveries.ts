import { sql, type SqlBool } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .createTable('github_webhook_deliveries')
    .addColumn('delivery_id', 'text', (column) => column.primaryKey())
    .addColumn('event', 'text', (column) => column.notNull())
    .addColumn('action', 'text')
    .addColumn('installation_id', 'text')
    .addColumn('repository_id', 'text')
    .addColumn('payload_hash', 'text', (column) => column.notNull())
    .addColumn('raw_payload', 'bytea')
    .addColumn('processing_state', 'text', (column) => column.notNull().defaultTo('queued'))
    .addColumn('attempt_count', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('error_code', 'text')
    .addColumn('received_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('processing_started_at', 'timestamptz')
    .addColumn('processed_at', 'timestamptz')
    .addColumn('raw_payload_expires_at', 'timestamptz', (column) => column.notNull())
    .addColumn('raw_payload_purged_at', 'timestamptz')
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'github_webhook_deliveries_payload_hash_check',
      sql`length(payload_hash) = 64`,
    )
    .addCheckConstraint('github_webhook_deliveries_attempt_count_check', sql`attempt_count >= 0`)
    .addCheckConstraint(
      'github_webhook_deliveries_state_check',
      sql`processing_state in ('queued', 'processing', 'succeeded', 'failed')`,
    )
    .addCheckConstraint(
      'github_webhook_deliveries_retention_check',
      sql`raw_payload_expires_at >= received_at`,
    )
    .execute()

  await database.schema
    .createIndex('github_webhook_deliveries_state_idx')
    .on('github_webhook_deliveries')
    .columns(['processing_state', 'updated_at'])
    .execute()
  await database.schema
    .createIndex('github_webhook_deliveries_raw_expiry_idx')
    .on('github_webhook_deliveries')
    .column('raw_payload_expires_at')
    .where(sql<SqlBool>`raw_payload is not null`)
    .execute()
}

export const down: Migration['down'] = async (database) => {
  await database.schema.dropTable('github_webhook_deliveries').execute()
}
