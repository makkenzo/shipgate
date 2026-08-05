import { type SqlBool, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .alterTable('github_webhook_deliveries')
    .addColumn('ignored_reason', 'text')
    .execute()

  await sql`
    alter table github_webhook_deliveries
      drop constraint github_webhook_deliveries_state_check,
      add constraint github_webhook_deliveries_state_check
        check (processing_state in ('queued', 'processing', 'succeeded', 'ignored', 'failed')),
      add constraint github_webhook_deliveries_ignored_state_check
        check (
          (
            processing_state = 'ignored'
            and ignored_reason is not null
            and length(btrim(ignored_reason)) > 0
            and processed_at is not null
          )
          or
          (processing_state <> 'ignored' and ignored_reason is null)
        )
  `.execute(database)

  await database.schema
    .alterTable('repository_sync_runs')
    .addColumn('reconciliation_classification', 'text')
    .addColumn('difference_summary', 'jsonb')
    .execute()

  await database.schema
    .alterTable('repository_sync_runs')
    .addCheckConstraint(
      'repository_sync_runs_reconciliation_classification_check',
      sql`
        reconciliation_classification is null
        or reconciliation_classification in (
          'expected_change',
          'recoverable_drift',
          'destructive_history_change',
          'permission_problem',
          'unknown_inconsistency'
        )
      `,
    )
    .execute()

  await database.schema
    .alterTable('repository_sync_runs')
    .addCheckConstraint(
      'repository_sync_runs_difference_summary_check',
      sql`difference_summary is null or jsonb_typeof(difference_summary) = 'object'`,
    )
    .execute()

  await database.schema
    .alterTable('repository_sync_runs')
    .addCheckConstraint(
      'repository_sync_runs_reconciliation_result_pair_check',
      sql`
        (reconciliation_classification is null and difference_summary is null)
        or
        (reconciliation_classification is not null and difference_summary is not null)
      `,
    )
    .execute()

  await database.schema
    .alterTable('repository_reconciliation_requests')
    .addColumn('trigger_scope', 'jsonb', (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('force_push', 'boolean', (column) => column.notNull().defaultTo(false))
    .addColumn('coalesced_count', 'integer', (column) => column.notNull().defaultTo(0))
    .execute()

  await database.schema
    .alterTable('repository_reconciliation_requests')
    .addCheckConstraint(
      'repository_reconciliation_requests_coalesced_count_check',
      sql`coalesced_count >= 0`,
    )
    .execute()

  await database.schema
    .alterTable('repository_reconciliation_requests')
    .addCheckConstraint(
      'repository_reconciliation_requests_trigger_scope_check',
      sql`jsonb_typeof(trigger_scope) = 'object'`,
    )
    .execute()

  await sql`
    do $$
    declare
      duplicate record;
    begin
      for duplicate in
        select
          ranked.id,
          ranked.sync_run_id,
          ranked.repository_id,
          ranked.survivor_id
        from (
          select
            request.id,
            request.sync_run_id,
            request.repository_id,
            first_value(request.id) over (
              partition by request.repository_id
              order by request.requested_at desc, request.id desc
            ) as survivor_id,
            row_number() over (
              partition by request.repository_id
              order by request.requested_at desc, request.id desc
            ) as position
          from repository_reconciliation_requests as request
          where request.status = 'queued'
        ) as ranked
        where ranked.position > 1
      loop
        perform set_config('shipgate.repository_id', duplicate.repository_id, true);
        perform set_config('shipgate.repository_lock', 'held', true);

        update repository_sync_runs
        set
          status = 'superseded',
          completed_at = now(),
          error_code = 'synchronization_superseded',
          error_message = 'Coalesced by the incremental synchronization migration'
        where id = duplicate.sync_run_id
          and status = 'queued';

        update repository_reconciliation_requests
        set
          status = 'superseded',
          superseded_by_request_id = duplicate.survivor_id,
          completed_at = now(),
          last_error_code = 'synchronization_superseded',
          last_error_message = 'Coalesced by the incremental synchronization migration',
          updated_at = now()
        where id = duplicate.id
          and status = 'queued';
      end loop;

      perform set_config('shipgate.repository_id', '', true);
      perform set_config('shipgate.repository_lock', '', true);
    end;
    $$
  `.execute(database)

  await database.schema
    .createIndex('repository_reconciliation_requests_one_queued_key')
    .unique()
    .on('repository_reconciliation_requests')
    .column('repository_id')
    .where(sql<SqlBool>`status = 'queued'`)
    .execute()

  await database.schema
    .createTable('repository_incremental_sync_requests')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('configuration_version', 'integer', (column) => column.notNull())
    .addColumn('sync_type', 'text', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull().defaultTo('queued'))
    .addColumn('scope', 'jsonb', (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('attempt_count', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('last_error_code', 'text')
    .addColumn('last_error_message', 'text')
    .addColumn('requested_at', 'timestamptz', (column) => column.notNull())
    .addColumn('claimed_at', 'timestamptz')
    .addColumn('completed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'repository_incremental_sync_configuration_version_check',
      sql`configuration_version > 0`,
    )
    .addCheckConstraint(
      'repository_incremental_sync_requests_type_check',
      sql`
        sync_type in (
          'refresh_branches',
          'refresh_change',
          'refresh_checks',
          'refresh_rules'
        )
      `,
    )
    .addCheckConstraint(
      'repository_incremental_sync_requests_status_check',
      sql`status in ('queued', 'running', 'succeeded', 'superseded', 'failed')`,
    )
    .addCheckConstraint(
      'repository_incremental_sync_requests_attempt_count_check',
      sql`attempt_count >= 0`,
    )
    .addCheckConstraint(
      'repository_incremental_sync_requests_scope_check',
      sql`jsonb_typeof(scope) = 'object'`,
    )
    .addCheckConstraint(
      'repository_incremental_sync_requests_state_timestamps_check',
      sql`
        (status = 'queued' and claimed_at is null and completed_at is null)
        or
        (status = 'running' and claimed_at is not null and completed_at is null)
        or
        (status in ('succeeded', 'superseded', 'failed') and completed_at is not null)
      `,
    )
    .addCheckConstraint(
      'repository_incremental_sync_requests_error_state_check',
      sql`
        (
          status in ('queued', 'succeeded')
          and last_error_code is null
          and last_error_message is null
        )
        or status = 'running'
        or (status in ('superseded', 'failed') and last_error_code is not null)
      `,
    )
    .execute()

  await sql`
    alter table repository_incremental_sync_requests
      add constraint repository_incremental_sync_requests_project_repository_fkey
      foreign key (project_id, repository_id)
      references projects (id, repository_id)
      on delete cascade
  `.execute(database)

  await database.schema
    .createIndex('repository_incremental_sync_requests_one_queued_type_key')
    .unique()
    .on('repository_incremental_sync_requests')
    .columns(['repository_id', 'sync_type'])
    .where(sql<SqlBool>`status = 'queued'`)
    .execute()

  await database.schema
    .createIndex('repository_incremental_sync_requests_runnable_idx')
    .on('repository_incremental_sync_requests')
    .columns(['status', 'requested_at'])
    .execute()

  await database.schema
    .createIndex('repository_incremental_sync_requests_project_idx')
    .on('repository_incremental_sync_requests')
    .columns(['project_id', 'requested_at'])
    .execute()

  await database.schema
    .createTable('repository_projection_archives')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('reconciliation_request_id', 'text', (column) =>
      column
        .notNull()
        .unique()
        .references('repository_reconciliation_requests.id')
        .onDelete('cascade'),
    )
    .addColumn('sync_run_id', 'text', (column) =>
      column.notNull().references('repository_sync_runs.id').onDelete('cascade'),
    )
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('source_sha', 'text')
    .addColumn('production_sha', 'text')
    .addColumn('classification', 'text', (column) => column.notNull())
    .addColumn('snapshot', 'jsonb', (column) => column.notNull())
    .addColumn('archived_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'repository_projection_archives_classification_check',
      sql`classification = 'destructive_history_change'`,
    )
    .addCheckConstraint(
      'repository_projection_archives_sha_pair_check',
      sql`(source_sha is null) = (production_sha is null)`,
    )
    .addCheckConstraint(
      'repository_projection_archives_source_sha_check',
      sql`source_sha is null or source_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'repository_projection_archives_production_sha_check',
      sql`production_sha is null or production_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'repository_projection_archives_snapshot_check',
      sql`jsonb_typeof(snapshot) = 'object'`,
    )
    .execute()

  await sql`
    alter table repository_projection_archives
      add constraint repository_projection_archives_project_repository_fkey
      foreign key (project_id, repository_id)
      references projects (id, repository_id)
      on delete cascade
  `.execute(database)

  await database.schema
    .createIndex('repository_projection_archives_project_idx')
    .on('repository_projection_archives')
    .columns(['project_id', 'archived_at'])
    .execute()

  await sql`
    create trigger repository_projection_archives_write_guard
    before insert or update or delete on repository_projection_archives
    for each row
    execute function shipgate_assert_repository_projection_write()
  `.execute(database)
}

export const down: Migration['down'] = async (database) => {
  await database.schema.dropTable('repository_projection_archives').execute()
  await database.schema.dropIndex('repository_reconciliation_requests_one_queued_key').execute()
  await database.schema.dropTable('repository_incremental_sync_requests').execute()

  await database.schema
    .alterTable('repository_reconciliation_requests')
    .dropConstraint('repository_reconciliation_requests_trigger_scope_check')
    .execute()
  await database.schema
    .alterTable('repository_reconciliation_requests')
    .dropConstraint('repository_reconciliation_requests_coalesced_count_check')
    .execute()
  await database.schema
    .alterTable('repository_reconciliation_requests')
    .dropColumn('coalesced_count')
    .dropColumn('force_push')
    .dropColumn('trigger_scope')
    .execute()

  await database.schema
    .alterTable('repository_sync_runs')
    .dropConstraint('repository_sync_runs_reconciliation_result_pair_check')
    .execute()
  await database.schema
    .alterTable('repository_sync_runs')
    .dropConstraint('repository_sync_runs_difference_summary_check')
    .execute()
  await database.schema
    .alterTable('repository_sync_runs')
    .dropConstraint('repository_sync_runs_reconciliation_classification_check')
    .execute()
  await database.schema
    .alterTable('repository_sync_runs')
    .dropColumn('difference_summary')
    .dropColumn('reconciliation_classification')
    .execute()

  await sql`
    alter table github_webhook_deliveries
      drop constraint github_webhook_deliveries_ignored_state_check,
      drop constraint github_webhook_deliveries_state_check,
      add constraint github_webhook_deliveries_state_check
        check (processing_state in ('queued', 'processing', 'succeeded', 'failed'))
  `.execute(database)

  await database.schema
    .alterTable('github_webhook_deliveries')
    .dropColumn('ignored_reason')
    .execute()
}
