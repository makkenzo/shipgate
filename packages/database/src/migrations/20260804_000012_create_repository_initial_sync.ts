import { type SqlBool, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await sql`
    alter table projects
      alter column status set default 'initializing',
      drop constraint projects_status_check,
      drop constraint projects_deletion_state_check,
      add constraint projects_status_check
        check (
          status in (
            'initializing',
            'active',
            'degraded',
            'disconnected',
            'pending_deletion',
            'deleted'
          )
        ),
      add constraint projects_deletion_state_check
        check (
          (
            status in ('initializing', 'active', 'degraded', 'disconnected')
            and deletion_requested_at is null
            and deleted_at is null
          )
          or
          (
            status = 'pending_deletion'
            and deletion_requested_at is not null
            and deleted_at is null
          )
          or
          (
            status = 'deleted'
            and deletion_requested_at is not null
            and deleted_at is not null
          )
        )
  `.execute(database)

  await sql`
    update projects
    set
      status = 'initializing',
      updated_at = now()
    where status = 'active'
      and last_successful_sync_at is null
  `.execute(database)

  await sql`
    alter table repository_sync_runs
      alter column status set default 'queued',
      drop constraint repository_sync_runs_status_check,
      drop constraint repository_sync_runs_terminal_state_check,
      add constraint repository_sync_runs_status_check
        check (status in ('queued', 'running', 'succeeded', 'superseded', 'failed')),
      add constraint repository_sync_runs_terminal_state_check
        check (
          (
            status = 'queued'
            and completed_at is null
            and projection_fingerprint is null
            and error_code is null
            and error_message is null
          )
          or
          (
            status = 'running'
            and completed_at is null
            and error_code is null
            and error_message is null
          )
          or
          (
            status = 'succeeded'
            and completed_at is not null
            and projection_fingerprint is not null
            and source_sha is not null
            and production_sha is not null
            and error_code is null
            and error_message is null
          )
          or
          (
            status = 'superseded'
            and completed_at is not null
            and error_code = 'synchronization_superseded'
          )
          or
          (
            status = 'failed'
            and completed_at is not null
            and error_code is not null
          )
        )
  `.execute(database)

  await database.schema
    .alterTable('repository_reconciliation_requests')
    .addColumn('sync_run_id', 'text')
    .addColumn('superseded_by_request_id', 'text')
    .addColumn('attempt_count', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('last_error_code', 'text')
    .addColumn('last_error_message', 'text')
    .execute()

  await sql`
    insert into repository_sync_runs (
      id,
      project_id,
      repository_id,
      reason,
      status,
      configuration_version,
      idempotency_key,
      projection_fingerprint,
      source_sha,
      production_sha,
      started_at,
      completed_at,
      error_code,
      error_message
    )
    select
      request.id,
      request.project_id,
      request.repository_id,
      request.reason,
      case request.status
        when 'queued' then 'queued'
        when 'claimed' then 'running'
        when 'completed' then 'superseded'
        when 'cancelled' then 'superseded'
      end,
      request.configuration_version,
      request.idempotency_key,
      null,
      request.source_sha,
      request.production_sha,
      coalesce(request.claimed_at, request.requested_at),
      case
        when request.status in ('completed', 'cancelled')
          then coalesce(request.completed_at, request.updated_at)
        else null
      end,
      case
        when request.status in ('completed', 'cancelled')
          then 'synchronization_superseded'
        else null
      end,
      case
        when request.status in ('completed', 'cancelled')
          then 'Legacy reconciliation request migrated without a committed projection'
        else null
      end
    from repository_reconciliation_requests as request
    on conflict (id) do nothing
  `.execute(database)

  await sql`
    update repository_reconciliation_requests
    set
      sync_run_id = id,
      status = case status
        when 'claimed' then 'running'
        when 'completed' then 'superseded'
        when 'cancelled' then 'cancelled'
        else status
      end,
      attempt_count = case when claimed_at is null then 0 else 1 end,
      last_error_code = case
        when status in ('completed', 'cancelled') then 'synchronization_superseded'
        else null
      end,
      last_error_message = case
        when status in ('completed', 'cancelled')
          then 'Legacy reconciliation request migrated without a committed projection'
        else null
      end
  `.execute(database)

  await database.schema
    .alterTable('repository_reconciliation_requests')
    .alterColumn('sync_run_id', (column) => column.setNotNull())
    .execute()

  await database.schema
    .alterTable('repository_reconciliation_requests')
    .addUniqueConstraint('repository_reconciliation_requests_sync_run_key', ['sync_run_id'])
    .execute()

  await database.schema
    .alterTable('repository_reconciliation_requests')
    .addCheckConstraint(
      'repository_reconciliation_requests_attempt_count_check',
      sql`attempt_count >= 0`,
    )
    .execute()

  await sql`
    alter table repository_reconciliation_requests
      drop constraint repository_reconciliation_requests_status_check,
      drop constraint repository_reconciliation_requests_state_timestamps_check,
      add constraint repository_reconciliation_requests_status_check
        check (
          status in (
            'queued',
            'running',
            'succeeded',
            'superseded',
            'failed',
            'cancelled'
          )
        ),
      add constraint repository_reconciliation_requests_state_timestamps_check
        check (
          (
            status = 'queued'
            and claimed_at is null
            and completed_at is null
          )
          or
          (
            status = 'running'
            and claimed_at is not null
            and completed_at is null
          )
          or
          (
            status in ('succeeded', 'superseded', 'failed', 'cancelled')
            and completed_at is not null
          )
        ),
      add constraint repository_reconciliation_requests_error_state_check
        check (
          (
            status in ('queued', 'running', 'succeeded')
            and last_error_code is null
            and last_error_message is null
          )
          or
          (
            status in ('superseded', 'failed', 'cancelled')
            and last_error_code is not null
          )
        ),
      add constraint repository_reconciliation_requests_supersession_state_check
        check (
          superseded_by_request_id is null
          or status = 'superseded'
        ),
      add constraint repository_reconciliation_requests_sync_run_fkey
        foreign key (sync_run_id)
        references repository_sync_runs (id)
        on delete cascade,
      add constraint repository_reconciliation_requests_superseded_by_fkey
        foreign key (superseded_by_request_id)
        references repository_reconciliation_requests (id)
        on delete set null
  `.execute(database)

  await database.schema.dropIndex('repository_reconciliation_requests_queue_idx').execute()

  await database.schema
    .createIndex('repository_reconciliation_requests_queue_idx')
    .on('repository_reconciliation_requests')
    .columns(['status', 'requested_at'])
    .where(sql<SqlBool>`status in ('queued', 'running')`)
    .execute()
}

export const down: Migration['down'] = async (database) => {
  await database.schema.dropIndex('repository_reconciliation_requests_queue_idx').execute()

  await sql`
    alter table repository_reconciliation_requests
      drop constraint repository_reconciliation_requests_superseded_by_fkey,
      drop constraint repository_reconciliation_requests_sync_run_fkey,
      drop constraint repository_reconciliation_requests_supersession_state_check,
      drop constraint repository_reconciliation_requests_error_state_check,
      drop constraint repository_reconciliation_requests_state_timestamps_check,
      drop constraint repository_reconciliation_requests_status_check,
      drop constraint repository_reconciliation_requests_sync_run_key
  `.execute(database)

  await sql`
    update repository_reconciliation_requests
    set status = case status
      when 'running' then 'claimed'
      when 'succeeded' then 'completed'
      when 'superseded' then 'completed'
      when 'failed' then 'completed'
      else status
    end
  `.execute(database)

  await sql`
    alter table repository_reconciliation_requests
      add constraint repository_reconciliation_requests_status_check
        check (status in ('queued', 'claimed', 'completed', 'cancelled')),
      add constraint repository_reconciliation_requests_state_timestamps_check
        check (
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
        )
  `.execute(database)

  await sql`
    delete from repository_sync_runs
    where id in (
      select sync_run_id
      from repository_reconciliation_requests
    )
  `.execute(database)

  await database.schema
    .alterTable('repository_reconciliation_requests')
    .dropColumn('last_error_message')
    .dropColumn('last_error_code')
    .dropColumn('attempt_count')
    .dropColumn('superseded_by_request_id')
    .dropColumn('sync_run_id')
    .execute()

  await database.schema
    .createIndex('repository_reconciliation_requests_queue_idx')
    .on('repository_reconciliation_requests')
    .columns(['status', 'requested_at'])
    .where(sql<SqlBool>`status in ('queued', 'claimed')`)
    .execute()

  await sql`
    alter table repository_sync_runs
      alter column status drop default,
      drop constraint repository_sync_runs_terminal_state_check,
      drop constraint repository_sync_runs_status_check,
      add constraint repository_sync_runs_status_check
        check (status in ('running', 'succeeded', 'failed')),
      add constraint repository_sync_runs_terminal_state_check
        check (
          (
            status = 'running'
            and completed_at is null
            and error_code is null
            and error_message is null
          )
          or
          (
            status = 'succeeded'
            and completed_at is not null
            and projection_fingerprint is not null
            and source_sha is not null
            and production_sha is not null
            and error_code is null
            and error_message is null
          )
          or
          (
            status = 'failed'
            and completed_at is not null
            and error_code is not null
          )
        )
  `.execute(database)

  await sql`
    update projects
    set status = case
      when status in ('initializing', 'degraded') then 'active'
      else status
    end
  `.execute(database)

  await sql`
    alter table projects
      alter column status set default 'active',
      drop constraint projects_deletion_state_check,
      drop constraint projects_status_check,
      add constraint projects_status_check
        check (status in ('active', 'disconnected', 'pending_deletion', 'deleted')),
      add constraint projects_deletion_state_check
        check (
          (
            status in ('active', 'disconnected')
            and deletion_requested_at is null
            and deleted_at is null
          )
          or
          (
            status = 'pending_deletion'
            and deletion_requested_at is not null
            and deleted_at is null
          )
          or
          (
            status = 'deleted'
            and deletion_requested_at is not null
            and deleted_at is not null
          )
        )
  `.execute(database)
}
