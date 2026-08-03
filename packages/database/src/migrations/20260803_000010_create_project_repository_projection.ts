import { sql, type SqlBool } from 'kysely'
import type { Migration } from 'kysely/migration'

const projectionTables = [
  'projects',
  'repository_branches',
  'repository_commits',
  'changes',
  'change_commits',
  'required_checks',
  'commit_check_results',
  'repository_sync_runs',
  'repository_sync_issues',
] as const

export const up: Migration['up'] = async (database) => {
  await database.schema
    .createTable('projects')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('installation_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('owner_id', 'text', (column) => column.notNull())
    .addColumn('owner_login', 'text', (column) => column.notNull())
    .addColumn('repository_name', 'text', (column) => column.notNull())
    .addColumn('repository_full_name', 'text', (column) => column.notNull())
    .addColumn('default_branch', 'text')
    .addColumn('source_branch', 'text', (column) => column.notNull())
    .addColumn('production_branch', 'text', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull().defaultTo('active'))
    .addColumn('source_sha', 'text')
    .addColumn('production_sha', 'text')
    .addColumn('last_successful_sync_at', 'timestamptz')
    .addColumn('configuration_version', 'integer', (column) => column.notNull().defaultTo(1))
    .addColumn('deletion_requested_at', 'timestamptz')
    .addColumn('deleted_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('projects_id_repository_key', ['id', 'repository_id'])
    .addCheckConstraint('projects_installation_id_check', sql`installation_id ~ '^[1-9][0-9]*$'`)
    .addCheckConstraint('projects_repository_id_check', sql`repository_id ~ '^[1-9][0-9]*$'`)
    .addCheckConstraint('projects_owner_id_check', sql`owner_id ~ '^[1-9][0-9]*$'`)
    .addCheckConstraint('projects_source_branch_check', sql`length(btrim(source_branch)) > 0`)
    .addCheckConstraint(
      'projects_production_branch_check',
      sql`length(btrim(production_branch)) > 0`,
    )
    .addCheckConstraint('projects_distinct_branches_check', sql`source_branch <> production_branch`)
    .addCheckConstraint(
      'projects_status_check',
      sql`status in ('active', 'disconnected', 'pending_deletion', 'deleted')`,
    )
    .addCheckConstraint('projects_configuration_version_check', sql`configuration_version > 0`)
    .addCheckConstraint(
      'projects_sha_pair_check',
      sql`(source_sha is null) = (production_sha is null)`,
    )
    .addCheckConstraint(
      'projects_source_sha_check',
      sql`source_sha is null or source_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'projects_production_sha_check',
      sql`production_sha is null or production_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'projects_deletion_state_check',
      sql`
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
      `,
    )
    .execute()

  await database.schema
    .createIndex('projects_one_non_deleted_repository_key')
    .unique()
    .on('projects')
    .column('repository_id')
    .where(sql<SqlBool>`status <> 'deleted'`)
    .execute()

  await database.schema
    .createIndex('projects_installation_idx')
    .on('projects')
    .columns(['installation_id', 'status'])
    .execute()

  await database.schema
    .createTable('repository_branches')
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('head_sha', 'text', (column) => column.notNull())
    .addColumn('protected', 'boolean', (column) => column.notNull().defaultTo(false))
    .addColumn('default_branch', 'boolean', (column) => column.notNull().defaultTo(false))
    .addColumn('observed_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('repository_branches_pkey', ['project_id', 'name'])
    .addCheckConstraint('repository_branches_name_check', sql`length(btrim(name)) > 0`)
    .addCheckConstraint('repository_branches_head_sha_check', sql`head_sha ~ '^[0-9a-f]{40,64}$'`)
    .execute()

  await database.schema
    .createIndex('repository_branches_repository_idx')
    .on('repository_branches')
    .columns(['repository_id', 'name'])
    .execute()

  await database.schema
    .createTable('repository_commits')
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('sha', 'text', (column) => column.notNull())
    .addColumn('tree_sha', 'text')
    .addColumn('message', 'text', (column) => column.notNull())
    .addColumn('author_id', 'text')
    .addColumn('author_login', 'text')
    .addColumn('author_name', 'text')
    .addColumn('author_email', 'text')
    .addColumn('committer_id', 'text')
    .addColumn('committer_login', 'text')
    .addColumn('authored_at', 'timestamptz')
    .addColumn('committed_at', 'timestamptz', (column) => column.notNull())
    .addColumn('parent_shas', 'jsonb', (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('source_delta_position', 'integer')
    .addColumn('observed_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('repository_commits_pkey', ['repository_id', 'sha'])
    .addUniqueConstraint('repository_commits_project_repository_sha_key', [
      'project_id',
      'repository_id',
      'sha',
    ])
    .addCheckConstraint('repository_commits_sha_check', sql`sha ~ '^[0-9a-f]{40,64}$'`)
    .addCheckConstraint(
      'repository_commits_tree_sha_check',
      sql`tree_sha is null or tree_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'repository_commits_author_id_check',
      sql`author_id is null or author_id ~ '^[1-9][0-9]*$'`,
    )
    .addCheckConstraint(
      'repository_commits_committer_id_check',
      sql`committer_id is null or committer_id ~ '^[1-9][0-9]*$'`,
    )
    .addCheckConstraint(
      'repository_commits_source_delta_position_check',
      sql`source_delta_position is null or source_delta_position >= 0`,
    )
    .execute()

  await database.schema
    .createIndex('repository_commits_source_delta_position_key')
    .unique()
    .on('repository_commits')
    .columns(['project_id', 'source_delta_position'])
    .where(sql<SqlBool>`source_delta_position is not null`)
    .execute()

  await database.schema
    .createIndex('repository_commits_project_committed_idx')
    .on('repository_commits')
    .columns(['project_id', 'committed_at'])
    .execute()

  await database.schema
    .createTable('changes')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('github_pull_request_id', 'text', (column) => column.notNull())
    .addColumn('pull_request_number', 'integer', (column) => column.notNull())
    .addColumn('title', 'text', (column) => column.notNull())
    .addColumn('url', 'text')
    .addColumn('author_id', 'text')
    .addColumn('author_login', 'text')
    .addColumn('base_branch', 'text', (column) => column.notNull())
    .addColumn('merged_at', 'timestamptz', (column) => column.notNull())
    .addColumn('final_head_sha', 'text', (column) => column.notNull())
    .addColumn('merge_commit_sha', 'text')
    .addColumn('source_integration_sha', 'text')
    .addColumn('merge_method', 'text', (column) => column.notNull())
    .addColumn('commit_set_fingerprint', 'text')
    .addColumn('synchronization_state', 'text', (column) => column.notNull())
    .addColumn('production_presence', 'text', (column) => column.notNull())
    .addColumn('observed_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('changes_id_repository_key', ['id', 'repository_id'])
    .addUniqueConstraint('changes_id_project_repository_key', ['id', 'project_id', 'repository_id'])
    .addUniqueConstraint('changes_repository_pull_request_id_key', [
      'repository_id',
      'github_pull_request_id',
    ])
    .addUniqueConstraint('changes_repository_pull_request_number_key', [
      'repository_id',
      'pull_request_number',
    ])
    .addCheckConstraint(
      'changes_github_pull_request_id_check',
      sql`github_pull_request_id ~ '^[1-9][0-9]*$'`,
    )
    .addCheckConstraint('changes_pull_request_number_check', sql`pull_request_number > 0`)
    .addCheckConstraint(
      'changes_author_id_check',
      sql`author_id is null or author_id ~ '^[1-9][0-9]*$'`,
    )
    .addCheckConstraint('changes_base_branch_check', sql`length(btrim(base_branch)) > 0`)
    .addCheckConstraint('changes_final_head_sha_check', sql`final_head_sha ~ '^[0-9a-f]{40,64}$'`)
    .addCheckConstraint(
      'changes_merge_commit_sha_check',
      sql`merge_commit_sha is null or merge_commit_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'changes_source_integration_sha_check',
      sql`source_integration_sha is null or source_integration_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'changes_merge_method_check',
      sql`merge_method in ('merge', 'squash', 'rebase', 'unknown')`,
    )
    .addCheckConstraint(
      'changes_commit_set_fingerprint_check',
      sql`commit_set_fingerprint is null or commit_set_fingerprint ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      'changes_synchronization_state_check',
      sql`synchronization_state in ('known', 'unknown')`,
    )
    .addCheckConstraint(
      'changes_production_presence_check',
      sql`production_presence in ('present', 'missing', 'unknown', 'not_applicable')`,
    )
    .addCheckConstraint(
      'changes_known_commit_set_check',
      sql`
        synchronization_state = 'unknown'
        or
        (
          merge_method <> 'unknown'
          and commit_set_fingerprint is not null
          and source_integration_sha is not null
        )
      `,
    )
    .execute()

  await database.schema
    .createIndex('changes_project_delta_idx')
    .on('changes')
    .columns(['project_id', 'synchronization_state', 'production_presence', 'merged_at'])
    .execute()

  await database.schema
    .createTable('change_commits')
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('change_id', 'text', (column) => column.notNull())
    .addColumn('commit_sha', 'text', (column) => column.notNull())
    .addColumn('position', 'integer', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('change_commits_pkey', ['change_id', 'commit_sha'])
    .addUniqueConstraint('change_commits_change_position_key', ['change_id', 'position'])
    .addUniqueConstraint('change_commits_repository_commit_key', ['repository_id', 'commit_sha'])
    .addCheckConstraint('change_commits_position_check', sql`position >= 0`)
    .addCheckConstraint('change_commits_commit_sha_check', sql`commit_sha ~ '^[0-9a-f]{40,64}$'`)
    .execute()

  await database.schema
    .createTable('required_checks')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('policy_version', 'integer', (column) => column.notNull())
    .addColumn('check_type', 'text', (column) => column.notNull())
    .addColumn('context', 'text', (column) => column.notNull())
    .addColumn('integration_id', 'text')
    .addColumn('source', 'text', (column) => column.notNull())
    .addColumn('source_reference', 'text')
    .addColumn('observed_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('required_checks_policy_version_check', sql`policy_version > 0`)
    .addCheckConstraint(
      'required_checks_type_check',
      sql`check_type in ('check_run', 'commit_status')`,
    )
    .addCheckConstraint('required_checks_context_check', sql`length(btrim(context)) > 0`)
    .addCheckConstraint(
      'required_checks_integration_id_check',
      sql`integration_id is null or integration_id ~ '^[1-9][0-9]*$'`,
    )
    .addCheckConstraint(
      'required_checks_source_check',
      sql`source in ('branch_protection', 'repository_ruleset')`,
    )
    .execute()

  await sql`
    create unique index required_checks_identity_key
      on required_checks (
        project_id,
        policy_version,
        check_type,
        context,
        coalesce(integration_id, '')
      )
  `.execute(database)

  await database.schema
    .createTable('commit_check_results')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('commit_sha', 'text', (column) => column.notNull())
    .addColumn('check_type', 'text', (column) => column.notNull())
    .addColumn('context', 'text', (column) => column.notNull())
    .addColumn('integration_id', 'text')
    .addColumn('github_object_id', 'text', (column) => column.notNull())
    .addColumn('attempt', 'integer')
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('conclusion', 'text')
    .addColumn('details_url', 'text')
    .addColumn('started_at', 'timestamptz')
    .addColumn('completed_at', 'timestamptz')
    .addColumn('observed_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'commit_check_results_commit_sha_check',
      sql`commit_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'commit_check_results_type_check',
      sql`check_type in ('check_run', 'commit_status')`,
    )
    .addCheckConstraint('commit_check_results_context_check', sql`length(btrim(context)) > 0`)
    .addCheckConstraint(
      'commit_check_results_integration_id_check',
      sql`integration_id is null or integration_id ~ '^[1-9][0-9]*$'`,
    )
    .addCheckConstraint(
      'commit_check_results_github_object_id_check',
      sql`github_object_id ~ '^[1-9][0-9]*$'`,
    )
    .addCheckConstraint('commit_check_results_attempt_check', sql`attempt is null or attempt > 0`)
    .addCheckConstraint(
      'commit_check_results_status_check',
      sql`status in ('queued', 'in_progress', 'pending', 'completed')`,
    )
    .addCheckConstraint(
      'commit_check_results_conclusion_check',
      sql`
        conclusion is null
        or conclusion in (
          'success',
          'failure',
          'neutral',
          'cancelled',
          'skipped',
          'timed_out',
          'action_required',
          'stale',
          'startup_failure',
          'error'
        )
      `,
    )
    .execute()

  await sql`
    create unique index commit_check_results_github_identity_key
      on commit_check_results (
        repository_id,
        check_type,
        github_object_id,
        coalesce(attempt, 0)
      )
  `.execute(database)

  await sql`
    create index commit_check_results_resolution_idx
      on commit_check_results (
        project_id,
        commit_sha,
        check_type,
        context,
        coalesce(integration_id, ''),
        observed_at desc
      )
  `.execute(database)

  await database.schema
    .createTable('repository_sync_runs')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('reason', 'text', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('configuration_version', 'integer', (column) => column.notNull())
    .addColumn('idempotency_key', 'text', (column) => column.notNull())
    .addColumn('projection_fingerprint', 'text')
    .addColumn('source_sha', 'text')
    .addColumn('production_sha', 'text')
    .addColumn('started_at', 'timestamptz', (column) => column.notNull())
    .addColumn('completed_at', 'timestamptz')
    .addColumn('error_code', 'text')
    .addColumn('error_message', 'text')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('repository_sync_runs_project_idempotency_key', [
      'project_id',
      'idempotency_key',
    ])
    .addUniqueConstraint('repository_sync_runs_id_project_repository_key', [
      'id',
      'project_id',
      'repository_id',
    ])
    .addCheckConstraint('repository_sync_runs_reason_check', sql`length(btrim(reason)) > 0`)
    .addCheckConstraint(
      'repository_sync_runs_status_check',
      sql`status in ('running', 'succeeded', 'failed')`,
    )
    .addCheckConstraint(
      'repository_sync_runs_configuration_version_check',
      sql`configuration_version > 0`,
    )
    .addCheckConstraint(
      'repository_sync_runs_idempotency_key_check',
      sql`length(btrim(idempotency_key)) > 0`,
    )
    .addCheckConstraint(
      'repository_sync_runs_projection_fingerprint_check',
      sql`projection_fingerprint is null or projection_fingerprint ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      'repository_sync_runs_sha_pair_check',
      sql`(source_sha is null) = (production_sha is null)`,
    )
    .addCheckConstraint(
      'repository_sync_runs_source_sha_check',
      sql`source_sha is null or source_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'repository_sync_runs_production_sha_check',
      sql`production_sha is null or production_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'repository_sync_runs_terminal_state_check',
      sql`
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
      `,
    )
    .execute()

  await database.schema
    .createIndex('repository_sync_runs_project_started_idx')
    .on('repository_sync_runs')
    .columns(['project_id', 'started_at'])
    .execute()

  await database.schema
    .createTable('repository_sync_issues')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('sync_run_id', 'text', (column) =>
      column.notNull().references('repository_sync_runs.id').onDelete('cascade'),
    )
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('severity', 'text', (column) => column.notNull())
    .addColumn('code', 'text', (column) => column.notNull())
    .addColumn('scope', 'text', (column) => column.notNull())
    .addColumn('subject_id', 'text')
    .addColumn('message', 'text', (column) => column.notNull())
    .addColumn('details', 'jsonb', (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'repository_sync_issues_severity_check',
      sql`severity in ('warning', 'error')`,
    )
    .addCheckConstraint('repository_sync_issues_code_check', sql`length(btrim(code)) > 0`)
    .addCheckConstraint(
      'repository_sync_issues_scope_check',
      sql`scope in ('repository', 'branch', 'change', 'commit', 'check')`,
    )
    .addCheckConstraint('repository_sync_issues_message_check', sql`length(btrim(message)) > 0`)
    .execute()

  await sql`
    create unique index repository_sync_issues_identity_key
      on repository_sync_issues (
        sync_run_id,
        code,
        scope,
        coalesce(subject_id, '')
      )
  `.execute(database)

  for (const table of projectionTables.slice(1)) {
    await sql
      .raw(`
      alter table ${table}
      add constraint ${table}_project_repository_fkey
      foreign key (project_id, repository_id)
      references projects (id, repository_id)
      on delete cascade
    `)
      .execute(database)
  }

  await sql`
    alter table change_commits
    add constraint change_commits_change_repository_fkey
    foreign key (change_id, project_id, repository_id)
    references changes (id, project_id, repository_id)
    on delete cascade
  `.execute(database)

  await sql`
    alter table change_commits
    add constraint change_commits_repository_commit_fkey
    foreign key (project_id, repository_id, commit_sha)
    references repository_commits (project_id, repository_id, sha)
    on delete cascade
  `.execute(database)

  await sql`
    alter table commit_check_results
    add constraint commit_check_results_repository_commit_fkey
    foreign key (project_id, repository_id, commit_sha)
    references repository_commits (project_id, repository_id, sha)
    on delete cascade
  `.execute(database)

  await sql`
    alter table repository_sync_issues
    add constraint repository_sync_issues_run_project_repository_fkey
    foreign key (sync_run_id, project_id, repository_id)
    references repository_sync_runs (id, project_id, repository_id)
    on delete cascade
  `.execute(database)

  await sql`
    create function shipgate_assert_repository_projection_write()
    returns trigger
    language plpgsql
    as $$
    declare
      expected_repository_id text;
      actual_repository_id text;
      lock_state text;
    begin
      expected_repository_id := current_setting('shipgate.repository_id', true);
      lock_state := current_setting('shipgate.repository_lock', true);
      if
        expected_repository_id is null
        or expected_repository_id = ''
        or lock_state is distinct from 'held'
      then
        raise exception 'repository projection write requires a repository transaction and lock'
          using errcode = 'P0001';
      end if;

      if tg_op = 'UPDATE' and old.repository_id is distinct from new.repository_id then
        raise exception 'repository identity is immutable'
          using errcode = 'P0001';
      end if;

      actual_repository_id := case
        when tg_op = 'INSERT' then new.repository_id
        else old.repository_id
      end;

      if actual_repository_id is distinct from expected_repository_id then
        raise exception 'repository projection write scope mismatch: expected %, received %',
          expected_repository_id,
          actual_repository_id
          using errcode = 'P0001';
      end if;

      if tg_op = 'DELETE' then
        return old;
      end if;

      return new;
    end;
    $$
  `.execute(database)

  for (const table of projectionTables) {
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
    create function shipgate_assert_change_identity_immutable()
    returns trigger
    language plpgsql
    as $$
    begin
      if
        new.id is distinct from old.id
        or new.project_id is distinct from old.project_id
        or new.repository_id is distinct from old.repository_id
        or new.github_pull_request_id is distinct from old.github_pull_request_id
        or new.pull_request_number is distinct from old.pull_request_number
      then
        raise exception 'change GitHub identity is immutable'
          using errcode = 'P0001';
      end if;

      return new;
    end;
    $$
  `.execute(database)

  await sql`
    create trigger changes_identity_immutable
    before update on changes
    for each row
    execute function shipgate_assert_change_identity_immutable()
  `.execute(database)
}

export const down: Migration['down'] = async (database) => {
  for (const table of [...projectionTables].reverse()) {
    await database.schema.dropTable(table).execute()
  }

  await sql`
    drop function shipgate_assert_change_identity_immutable()
  `.execute(database)

  await sql`
    drop function shipgate_assert_repository_projection_write()
  `.execute(database)
}
