import { type SqlBool, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .createTable('project_audit_events')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('actor_github_user_id', 'text')
    .addColumn('event_type', 'text', (column) => column.notNull())
    .addColumn('source', 'text', (column) => column.notNull())
    .addColumn('configuration_version', 'integer', (column) => column.notNull())
    .addColumn('payload', 'jsonb', (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('occurred_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'project_audit_events_actor_check',
      sql`actor_github_user_id is null or actor_github_user_id ~ '^[1-9][0-9]*$'`,
    )
    .addCheckConstraint(
      'project_audit_events_event_type_check',
      sql`
        event_type in (
          'project_created',
          'project_configuration_changed',
          'project_deletion_requested'
        )
      `,
    )
    .addCheckConstraint(
      'project_audit_events_source_check',
      sql`source in ('user', 'system', 'reconciliation')`,
    )
    .addCheckConstraint(
      'project_audit_events_configuration_version_check',
      sql`configuration_version > 0`,
    )
    .execute()

  await sql`
    alter table project_audit_events
    add constraint project_audit_events_project_repository_fkey
    foreign key (project_id, repository_id)
    references projects (id, repository_id)
    on delete cascade
  `.execute(database)

  await database.schema
    .createIndex('project_audit_events_project_occurred_idx')
    .on('project_audit_events')
    .columns(['project_id', 'occurred_at'])
    .execute()

  await database.schema
    .createTable('repository_reconciliation_requests')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('configuration_version', 'integer', (column) => column.notNull())
    .addColumn('reason', 'text', (column) => column.notNull())
    .addColumn('mode', 'text', (column) => column.notNull().defaultTo('full'))
    .addColumn('status', 'text', (column) => column.notNull().defaultTo('queued'))
    .addColumn('requested_by_github_user_id', 'text')
    .addColumn('source_sha', 'text', (column) => column.notNull())
    .addColumn('production_sha', 'text', (column) => column.notNull())
    .addColumn('idempotency_key', 'text', (column) => column.notNull())
    .addColumn('requested_at', 'timestamptz', (column) => column.notNull())
    .addColumn('claimed_at', 'timestamptz')
    .addColumn('completed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('repository_reconciliation_requests_project_idempotency_key', [
      'project_id',
      'idempotency_key',
    ])
    .addCheckConstraint(
      'repository_reconciliation_requests_configuration_version_check',
      sql`configuration_version > 0`,
    )
    .addCheckConstraint(
      'repository_reconciliation_requests_reason_check',
      sql`length(btrim(reason)) > 0`,
    )
    .addCheckConstraint('repository_reconciliation_requests_mode_check', sql`mode = 'full'`)
    .addCheckConstraint(
      'repository_reconciliation_requests_status_check',
      sql`status in ('queued', 'claimed', 'completed', 'cancelled')`,
    )
    .addCheckConstraint(
      'repository_reconciliation_requests_actor_check',
      sql`
        requested_by_github_user_id is null
        or requested_by_github_user_id ~ '^[1-9][0-9]*$'
      `,
    )
    .addCheckConstraint(
      'repository_reconciliation_requests_source_sha_check',
      sql`source_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'repository_reconciliation_requests_production_sha_check',
      sql`production_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'repository_reconciliation_requests_idempotency_key_check',
      sql`length(btrim(idempotency_key)) > 0`,
    )
    .addCheckConstraint(
      'repository_reconciliation_requests_state_timestamps_check',
      sql`
        (
          status = 'queued'
          and claimed_at is null
          and completed_at is null
        )
        or
        (
          status = 'claimed'
          and claimed_at is not null
          and completed_at is null
        )
        or
        (
          status in ('completed', 'cancelled')
          and completed_at is not null
        )
      `,
    )
    .execute()

  await sql`
    alter table repository_reconciliation_requests
    add constraint repository_reconciliation_requests_project_repository_fkey
    foreign key (project_id, repository_id)
    references projects (id, repository_id)
    on delete cascade
  `.execute(database)

  await database.schema
    .createIndex('repository_reconciliation_requests_queue_idx')
    .on('repository_reconciliation_requests')
    .columns(['status', 'requested_at'])
    .where(sql<SqlBool>`status in ('queued', 'claimed')`)
    .execute()

  await database.schema
    .createIndex('repository_reconciliation_requests_project_idx')
    .on('repository_reconciliation_requests')
    .columns(['project_id', 'configuration_version'])
    .execute()

  for (const table of ['project_audit_events', 'repository_reconciliation_requests'] as const) {
    await sql
      .raw(`
      create trigger ${table}_repository_projection_write_guard
      before insert or update or delete on ${table}
      for each row
      execute function shipgate_assert_repository_projection_write()
    `)
      .execute(database)
  }

  await sql`
    create function shipgate_reject_project_audit_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception using
        errcode = 'P0001',
        message = 'project audit events are append-only';
    end;
    $$
  `.execute(database)

  await sql`
    create trigger project_audit_events_append_only
    before update or delete on project_audit_events
    for each row
    execute function shipgate_reject_project_audit_mutation()
  `.execute(database)
}

export const down: Migration['down'] = async (database) => {
  await database.schema.dropTable('repository_reconciliation_requests').execute()
  await database.schema.dropTable('project_audit_events').execute()
  await sql`drop function shipgate_reject_project_audit_mutation()`.execute(database)
}
