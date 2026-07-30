import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .createTable('shipgate_job_execution')
    .addColumn('graphile_job_id', 'text', (column) => column.primaryKey())
    .addColumn('task_identifier', 'text', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull().defaultTo('queued'))
    .addColumn('correlation_id', 'text', (column) => column.notNull())
    .addColumn('causation_id', 'text')
    .addColumn('payload', 'jsonb', (column) => column.notNull())
    .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('max_attempts', 'integer', (column) => column.notNull())
    .addColumn('result', 'jsonb')
    .addColumn('last_error', 'jsonb')
    .addColumn('queued_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('started_at', 'timestamptz')
    .addColumn('completed_at', 'timestamptz')
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'shipgate_job_execution_status_check',
      sql`
        status in (
          'queued',
          'running',
          'retrying',
          'succeeded',
          'failed'
        )
      `,
    )
    .execute()

  await database.schema
    .createIndex('shipgate_job_execution_status_idx')
    .on('shipgate_job_execution')
    .columns(['status', 'updated_at'])
    .execute()

  await database.schema
    .createIndex('shipgate_job_execution_correlation_idx')
    .on('shipgate_job_execution')
    .column('correlation_id')
    .execute()

  await database.schema
    .createTable('shipgate_worker_heartbeat')
    .addColumn('worker_id', 'text', (column) => column.primaryKey())
    .addColumn('hostname', 'text', (column) => column.notNull())
    .addColumn('pid', 'integer', (column) => column.notNull())
    .addColumn('app_version', 'text', (column) => column.notNull())
    .addColumn('started_at', 'timestamptz', (column) => column.notNull())
    .addColumn('heartbeat_at', 'timestamptz', (column) => column.notNull())
    .execute()

  await database.schema
    .createIndex('shipgate_worker_heartbeat_at_idx')
    .on('shipgate_worker_heartbeat')
    .column('heartbeat_at')
    .execute()
}

export const down: Migration['down'] = async (database) => {
  await database.schema.dropTable('shipgate_worker_heartbeat').execute()

  await database.schema.dropTable('shipgate_job_execution').execute()
}
