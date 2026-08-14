import { type SqlBool, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

const guardedReleasePlanningTables = [
  'change_qa_assessments',
  'change_dependencies',
  'release_candidates',
  'candidate_exclusions',
  'release_candidate_evaluations',
] as const

export const up: Migration['up'] = async (database) => {
  await sql`alter table project_audit_events rename to audit_events`.execute(database)
  await sql`
    alter table audit_events
    rename constraint project_audit_events_pkey
    to audit_events_pkey
  `.execute(database)
  await sql`
    alter index project_audit_events_project_occurred_idx
    rename to audit_events_project_occurred_idx
  `.execute(database)
  await sql`
    alter table audit_events
    rename constraint project_audit_events_project_repository_fkey
    to audit_events_project_repository_fkey
  `.execute(database)
  await sql`
    alter table audit_events
    rename constraint project_audit_events_actor_check
    to audit_events_actor_check
  `.execute(database)
  await sql`
    alter trigger project_audit_events_repository_projection_write_guard on audit_events
    rename to audit_events_repository_projection_write_guard
  `.execute(database)
  await sql`
    alter trigger project_audit_events_append_only on audit_events
    rename to audit_events_append_only
  `.execute(database)
  await sql`
    alter function shipgate_reject_project_audit_mutation()
    rename to shipgate_reject_audit_mutation
  `.execute(database)
  await sql`
    create or replace function shipgate_reject_audit_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' and not exists (
        select 1
        from projects
        where id = old.project_id
          and repository_id = old.repository_id
      ) then
        return old;
      end if;

      raise exception using
        errcode = 'P0001',
        message = 'audit events are append-only while their Project exists';
    end;
    $$
  `.execute(database)

  await sql`
    alter table audit_events
      drop constraint project_audit_events_event_type_check,
      drop constraint project_audit_events_source_check,
      drop constraint project_audit_events_configuration_version_check
  `.execute(database)

  await database.schema
    .alterTable('audit_events')
    .addColumn('entity_type', 'text', (column) => column.notNull().defaultTo('project'))
    .addColumn('entity_id', 'text')
    .addColumn('correlation_id', 'text')
    .addColumn('reason_code', 'text')
    .addColumn('before_state', 'jsonb')
    .addColumn('after_state', 'jsonb')
    .execute()

  await sql`
    alter table audit_events disable trigger audit_events_append_only;
    alter table audit_events disable trigger audit_events_repository_projection_write_guard
  `.execute(database)

  await sql`
    update audit_events
    set entity_id = project_id
    where entity_id is null
  `.execute(database)

  await sql`
    alter table audit_events enable trigger audit_events_repository_projection_write_guard;
    alter table audit_events enable trigger audit_events_append_only
  `.execute(database)

  await database.schema
    .alterTable('audit_events')
    .alterColumn('entity_type', (column) => column.dropDefault())
    .alterColumn('entity_id', (column) => column.setNotNull())
    .alterColumn('configuration_version', (column) => column.dropNotNull())
    .execute()

  await sql`
    alter table audit_events
      add constraint audit_events_event_type_check
        check (length(btrim(event_type)) > 0),
      add constraint audit_events_source_check
        check (source in ('user', 'webhook', 'reconciliation', 'system')),
      add constraint audit_events_configuration_version_check
        check (configuration_version is null or configuration_version > 0),
      add constraint audit_events_entity_type_check
        check (length(btrim(entity_type)) > 0),
      add constraint audit_events_entity_id_check
        check (length(btrim(entity_id)) > 0),
      add constraint audit_events_correlation_id_check
        check (
          correlation_id is null
          or correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'
        ),
      add constraint audit_events_reason_code_check
        check (
          reason_code is null
          or reason_code ~ '^[a-z][a-z0-9._:-]{0,127}$'
        )
  `.execute(database)

  await database.schema
    .createIndex('audit_events_entity_occurred_idx')
    .on('audit_events')
    .columns(['project_id', 'entity_type', 'entity_id', 'occurred_at'])
    .execute()

  await database.schema
    .createTable('change_qa_assessments')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('change_id', 'text', (column) => column.notNull())
    .addColumn('final_head_sha', 'text', (column) => column.notNull())
    .addColumn('commit_set_fingerprint', 'text', (column) => column.notNull())
    .addColumn('sequence', 'integer', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('actor_github_user_id', 'text')
    .addColumn('comment', 'text')
    .addColumn('previous_status', 'text')
    .addColumn('correlation_id', 'text', (column) => column.notNull())
    .addColumn('reason_code', 'text', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('change_qa_assessments_change_sequence_key', ['change_id', 'sequence'])
    .addCheckConstraint('change_qa_assessments_change_id_check', sql`length(btrim(change_id)) > 0`)
    .addCheckConstraint(
      'change_qa_assessments_final_head_sha_check',
      sql`final_head_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'change_qa_assessments_fingerprint_check',
      sql`commit_set_fingerprint ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint('change_qa_assessments_sequence_check', sql`sequence > 0`)
    .addCheckConstraint(
      'change_qa_assessments_status_check',
      sql`status in ('pending', 'passed', 'failed')`,
    )
    .addCheckConstraint(
      'change_qa_assessments_previous_status_check',
      sql`previous_status is null or previous_status in ('pending', 'passed', 'failed')`,
    )
    .addCheckConstraint(
      'change_qa_assessments_actor_check',
      sql`actor_github_user_id is null or actor_github_user_id ~ '^[1-9][0-9]*$'`,
    )
    .addCheckConstraint(
      'change_qa_assessments_comment_check',
      sql`
        comment is null
        or length(comment) <= 4000
      `,
    )
    .addCheckConstraint(
      'change_qa_assessments_correlation_id_check',
      sql`correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'`,
    )
    .addCheckConstraint(
      'change_qa_assessments_reason_code_check',
      sql`reason_code ~ '^[a-z][a-z0-9._:-]{0,127}$'`,
    )
    .execute()

  await sql`
    alter table change_qa_assessments
    add constraint change_qa_assessments_project_repository_fkey
    foreign key (project_id, repository_id)
    references projects (id, repository_id)
    on delete cascade
  `.execute(database)

  await database.schema
    .createIndex('change_qa_assessments_current_lookup_idx')
    .on('change_qa_assessments')
    .columns(['project_id', 'change_id', 'final_head_sha', 'commit_set_fingerprint', 'sequence'])
    .execute()

  await database.schema
    .createTable('change_dependencies')
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('dependent_change_id', 'text', (column) => column.notNull())
    .addColumn('prerequisite_change_id', 'text', (column) => column.notNull())
    .addColumn('source', 'text', (column) => column.notNull())
    .addColumn('actor_github_user_id', 'text')
    .addColumn('comment', 'text')
    .addColumn('version', 'integer', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('change_dependencies_pkey', [
      'project_id',
      'dependent_change_id',
      'prerequisite_change_id',
    ])
    .addCheckConstraint(
      'change_dependencies_distinct_changes_check',
      sql`dependent_change_id <> prerequisite_change_id`,
    )
    .addCheckConstraint(
      'change_dependencies_source_check',
      sql`source in ('user', 'managed_pr_body', 'system')`,
    )
    .addCheckConstraint(
      'change_dependencies_actor_check',
      sql`actor_github_user_id is null or actor_github_user_id ~ '^[1-9][0-9]*$'`,
    )
    .addCheckConstraint(
      'change_dependencies_comment_check',
      sql`
        comment is null
        or length(comment) <= 4000
      `,
    )
    .addCheckConstraint('change_dependencies_version_check', sql`version > 0`)
    .execute()

  await sql`
    alter table change_dependencies
    add constraint change_dependencies_project_repository_fkey
    foreign key (project_id, repository_id)
    references projects (id, repository_id)
    on delete cascade
  `.execute(database)

  await database.schema
    .createIndex('change_dependencies_prerequisite_idx')
    .on('change_dependencies')
    .columns(['project_id', 'prerequisite_change_id', 'dependent_change_id'])
    .execute()

  await database.schema
    .createTable('release_candidates')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('sequence', 'integer', (column) => column.notNull())
    .addColumn('state', 'text', (column) => column.notNull().defaultTo('open'))
    .addColumn('version', 'integer', (column) => column.notNull().defaultTo(1))
    .addColumn('created_by_github_user_id', 'text', (column) => column.notNull())
    .addColumn('note', 'text')
    .addColumn('latest_evaluation_version', 'integer')
    .addColumn('closed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('release_candidates_id_project_repository_key', [
      'id',
      'project_id',
      'repository_id',
    ])
    .addUniqueConstraint('release_candidates_project_sequence_key', ['project_id', 'sequence'])
    .addCheckConstraint('release_candidates_sequence_check', sql`sequence > 0`)
    .addCheckConstraint('release_candidates_version_check', sql`version > 0`)
    .addCheckConstraint(
      'release_candidates_state_check',
      sql`state in ('open', 'revision_active', 'completed', 'cancelled')`,
    )
    .addCheckConstraint(
      'release_candidates_creator_check',
      sql`created_by_github_user_id ~ '^[1-9][0-9]*$'`,
    )
    .addCheckConstraint(
      'release_candidates_note_check',
      sql`
        note is null
        or length(note) <= 4000
      `,
    )
    .addCheckConstraint(
      'release_candidates_latest_evaluation_version_check',
      sql`latest_evaluation_version is null or latest_evaluation_version > 0`,
    )
    .addCheckConstraint(
      'release_candidates_terminal_timestamp_check',
      sql`
        (state in ('open', 'revision_active') and closed_at is null)
        or
        (state in ('completed', 'cancelled') and closed_at is not null)
      `,
    )
    .execute()

  await sql`
    alter table release_candidates
    add constraint release_candidates_project_repository_fkey
    foreign key (project_id, repository_id)
    references projects (id, repository_id)
    on delete cascade
  `.execute(database)

  await database.schema
    .createIndex('release_candidates_one_active_project_key')
    .unique()
    .on('release_candidates')
    .column('project_id')
    .where(sql<SqlBool>`state in ('open', 'revision_active')`)
    .execute()

  await database.schema
    .createTable('candidate_exclusions')
    .addColumn('candidate_id', 'text', (column) => column.notNull())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('change_id', 'text', (column) => column.notNull())
    .addColumn('actor_github_user_id', 'text', (column) => column.notNull())
    .addColumn('reason', 'text')
    .addColumn('candidate_version', 'integer', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('candidate_exclusions_pkey', ['candidate_id', 'change_id'])
    .addCheckConstraint(
      'candidate_exclusions_actor_check',
      sql`actor_github_user_id ~ '^[1-9][0-9]*$'`,
    )
    .addCheckConstraint(
      'candidate_exclusions_reason_check',
      sql`
        reason is null
        or length(reason) <= 4000
      `,
    )
    .addCheckConstraint('candidate_exclusions_candidate_version_check', sql`candidate_version > 0`)
    .execute()

  await sql`
    alter table candidate_exclusions
    add constraint candidate_exclusions_candidate_fkey
    foreign key (candidate_id, project_id, repository_id)
    references release_candidates (id, project_id, repository_id)
    on delete cascade
  `.execute(database)

  await database.schema
    .createIndex('candidate_exclusions_project_change_idx')
    .on('candidate_exclusions')
    .columns(['project_id', 'change_id'])
    .execute()

  await database.schema
    .createTable('release_candidate_evaluations')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('candidate_id', 'text', (column) => column.notNull())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('evaluation_version', 'integer', (column) => column.notNull())
    .addColumn('candidate_version', 'integer', (column) => column.notNull())
    .addColumn('configuration_version', 'integer', (column) => column.notNull())
    .addColumn('source_sha', 'text', (column) => column.notNull())
    .addColumn('production_sha', 'text', (column) => column.notNull())
    .addColumn('projection_fingerprint', 'text', (column) => column.notNull())
    .addColumn('required_check_policy_version', 'integer', (column) => column.notNull())
    .addColumn('result', 'text', (column) => column.notNull())
    .addColumn('evaluation_fingerprint', 'text', (column) => column.notNull())
    .addColumn('summary', 'jsonb', (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('blockers', 'jsonb', (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('evaluated_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('release_candidate_evaluations_evaluation_version_key', [
      'candidate_id',
      'evaluation_version',
    ])
    .addUniqueConstraint('release_candidate_evaluations_candidate_version_key', [
      'candidate_id',
      'evaluation_version',
      'candidate_version',
    ])
    .addCheckConstraint(
      'release_candidate_evaluations_version_check',
      sql`evaluation_version > 0 and candidate_version > 0 and configuration_version > 0`,
    )
    .addCheckConstraint(
      'release_candidate_evaluations_source_sha_check',
      sql`source_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'release_candidate_evaluations_production_sha_check',
      sql`production_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'release_candidate_evaluations_projection_fingerprint_check',
      sql`projection_fingerprint ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      'release_candidate_evaluations_policy_version_check',
      sql`required_check_policy_version >= 0`,
    )
    .addCheckConstraint(
      'release_candidate_evaluations_result_check',
      sql`result in ('ready', 'blocked')`,
    )
    .addCheckConstraint(
      'release_candidate_evaluations_fingerprint_check',
      sql`evaluation_fingerprint ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      'release_candidate_evaluations_summary_check',
      sql`jsonb_typeof(summary) = 'object'`,
    )
    .addCheckConstraint(
      'release_candidate_evaluations_blockers_check',
      sql`jsonb_typeof(blockers) = 'array'`,
    )
    .execute()

  await sql`
    alter table release_candidate_evaluations
    add constraint release_candidate_evaluations_candidate_fkey
    foreign key (candidate_id, project_id, repository_id)
    references release_candidates (id, project_id, repository_id)
    on delete cascade
  `.execute(database)

  await sql`
    alter table release_candidates
    add constraint release_candidates_latest_evaluation_fkey
    foreign key (id, latest_evaluation_version, version)
    references release_candidate_evaluations (
      candidate_id,
      evaluation_version,
      candidate_version
    )
    deferrable initially deferred
  `.execute(database)

  await database.schema
    .createIndex('release_candidate_evaluations_project_idx')
    .on('release_candidate_evaluations')
    .columns(['project_id', 'candidate_id', 'evaluation_version'])
    .execute()

  /*
   * Human decisions deliberately do not reference `changes` with a foreign key.
   * The GitHub projection may remove a row during reconciliation; Shipgate-owned
   * history must survive and simply stop matching the effective current view.
   */
  await sql`
    create function shipgate_assert_release_planning_change_scope()
    returns trigger
    language plpgsql
    as $$
    declare
      scoped_change_id text;
    begin
      if tg_table_name = 'change_dependencies' then
        if not exists (
          select 1
          from changes
          where id = new.dependent_change_id
            and project_id = new.project_id
            and repository_id = new.repository_id
            and synchronization_state = 'known'
        ) then
          raise exception 'dependent Change % does not belong to Project %',
            new.dependent_change_id,
            new.project_id
            using errcode = '23514';
        end if;

        if not exists (
          select 1
          from changes
          where id = new.prerequisite_change_id
            and project_id = new.project_id
            and repository_id = new.repository_id
            and synchronization_state = 'known'
        ) then
          raise exception 'prerequisite Change % does not belong to Project %',
            new.prerequisite_change_id,
            new.project_id
            using errcode = '23514';
        end if;

        if exists (
          with recursive prerequisites(change_id) as (
            select new.prerequisite_change_id

            union

            select dependency.prerequisite_change_id
            from change_dependencies as dependency
            inner join prerequisites as current
              on current.change_id = dependency.dependent_change_id
            where dependency.project_id = new.project_id
              and dependency.repository_id = new.repository_id
          )
          select 1
          from prerequisites
          where change_id = new.dependent_change_id
        ) then
          raise exception 'Dependency graph for Project % would contain a cycle', new.project_id
            using errcode = '23514';
        end if;

        return new;
      end if;

      scoped_change_id := case tg_table_name
        when 'change_qa_assessments' then new.change_id
        when 'candidate_exclusions' then new.change_id
        else null
      end;

      if scoped_change_id is null then
        raise exception 'unsupported release-planning scope table %', tg_table_name
          using errcode = 'P0001';
      end if;

      if tg_table_name = 'change_qa_assessments' then
        if not exists (
          select 1
          from changes
          where id = new.change_id
            and project_id = new.project_id
            and repository_id = new.repository_id
            and final_head_sha = new.final_head_sha
            and commit_set_fingerprint = new.commit_set_fingerprint
            and synchronization_state = 'known'
        ) then
          raise exception 'QA assessment does not match the current version of Change %', new.change_id
            using errcode = '23514';
        end if;
      elsif not exists (
        select 1
        from changes
        where id = scoped_change_id
          and project_id = new.project_id
          and repository_id = new.repository_id
          and synchronization_state = 'known'
      ) then
        raise exception 'Change % does not belong to Project %', scoped_change_id, new.project_id
          using errcode = '23514';
      end if;

      return new;
    end;
    $$
  `.execute(database)

  for (const table of [
    'change_qa_assessments',
    'change_dependencies',
    'candidate_exclusions',
  ] as const) {
    await sql
      .raw(`
      create trigger ${table}_change_scope_guard
      before insert or update on ${table}
      for each row
      execute function shipgate_assert_release_planning_change_scope()
    `)
      .execute(database)
  }

  await sql`
    create function shipgate_reject_release_planning_snapshot_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      if tg_op = 'DELETE' and not exists (
        select 1
        from projects
        where id = old.project_id
          and repository_id = old.repository_id
      ) then
        return old;
      end if;

      raise exception '% records are immutable while their Project exists', tg_table_name
        using errcode = 'P0001';
    end;
    $$
  `.execute(database)

  for (const table of ['change_qa_assessments', 'release_candidate_evaluations'] as const) {
    await sql
      .raw(`
      create trigger ${table}_immutable
      before update or delete on ${table}
      for each row
      execute function shipgate_reject_release_planning_snapshot_mutation()
    `)
      .execute(database)
  }

  for (const table of guardedReleasePlanningTables) {
    await sql
      .raw(`
      create trigger ${table}_repository_write_guard
      before insert or update or delete on ${table}
      for each row
      execute function shipgate_assert_repository_projection_write()
    `)
      .execute(database)
  }

  await sql`
    create view effective_change_qa_assessments as
    select distinct on (assessment.change_id)
      assessment.id,
      assessment.project_id,
      assessment.repository_id,
      assessment.change_id,
      assessment.final_head_sha,
      assessment.commit_set_fingerprint,
      assessment.sequence,
      assessment.status,
      assessment.actor_github_user_id,
      assessment.comment,
      assessment.previous_status,
      assessment.correlation_id,
      assessment.reason_code,
      assessment.created_at
    from change_qa_assessments as assessment
    inner join changes as change
      on change.id = assessment.change_id
      and change.project_id = assessment.project_id
      and change.repository_id = assessment.repository_id
      and change.final_head_sha = assessment.final_head_sha
      and change.commit_set_fingerprint = assessment.commit_set_fingerprint
    where change.synchronization_state = 'known'
    order by
      assessment.change_id,
      assessment.sequence desc,
      assessment.created_at desc,
      assessment.id desc
  `.execute(database)
}

export const down: Migration['down'] = async (database) => {
  await sql`drop view effective_change_qa_assessments`.execute(database)

  await database.schema
    .alterTable('release_candidates')
    .dropConstraint('release_candidates_latest_evaluation_fkey')
    .execute()
  await database.schema.dropTable('candidate_exclusions').execute()
  await database.schema.dropTable('release_candidate_evaluations').execute()
  await database.schema.dropTable('release_candidates').execute()
  await database.schema.dropTable('change_dependencies').execute()
  await database.schema.dropTable('change_qa_assessments').execute()

  await sql`drop function shipgate_reject_release_planning_snapshot_mutation()`.execute(database)
  await sql`drop function shipgate_assert_release_planning_change_scope()`.execute(database)

  await sql`
    alter table audit_events disable trigger audit_events_append_only;
    alter table audit_events disable trigger audit_events_repository_projection_write_guard
  `.execute(database)

  await sql`
    delete from audit_events
    where configuration_version is null
      or entity_type <> 'project'
      or entity_id <> project_id
      or source not in ('user', 'system', 'reconciliation')
      or event_type not in (
        'project_created',
        'project_configuration_changed',
        'project_required_check_overrides_changed',
        'required_check_policy_changed',
        'required_check_policy_refreshed',
        'project_deletion_requested'
      )
  `.execute(database)

  await database.schema.dropIndex('audit_events_entity_occurred_idx').execute()

  await sql`
    alter table audit_events
      drop constraint audit_events_reason_code_check,
      drop constraint audit_events_correlation_id_check,
      drop constraint audit_events_entity_id_check,
      drop constraint audit_events_entity_type_check,
      drop constraint audit_events_configuration_version_check,
      drop constraint audit_events_source_check,
      drop constraint audit_events_event_type_check
  `.execute(database)

  await database.schema
    .alterTable('audit_events')
    .dropColumn('after_state')
    .dropColumn('before_state')
    .dropColumn('reason_code')
    .dropColumn('correlation_id')
    .dropColumn('entity_id')
    .dropColumn('entity_type')
    .alterColumn('configuration_version', (column) => column.setNotNull())
    .execute()

  await sql`
    alter table audit_events
      add constraint project_audit_events_event_type_check
        check (
          event_type in (
            'project_created',
            'project_configuration_changed',
            'project_required_check_overrides_changed',
            'required_check_policy_changed',
            'required_check_policy_refreshed',
            'project_deletion_requested'
          )
        ),
      add constraint project_audit_events_source_check
        check (source in ('user', 'system', 'reconciliation')),
      add constraint project_audit_events_configuration_version_check
        check (configuration_version > 0)
  `.execute(database)

  await sql`
    alter table audit_events
    rename constraint audit_events_actor_check
    to project_audit_events_actor_check
  `.execute(database)
  await sql`
    alter table audit_events
    rename constraint audit_events_project_repository_fkey
    to project_audit_events_project_repository_fkey
  `.execute(database)
  await sql`
    alter table audit_events
    rename constraint audit_events_pkey
    to project_audit_events_pkey
  `.execute(database)
  await sql`
    alter index audit_events_project_occurred_idx
    rename to project_audit_events_project_occurred_idx
  `.execute(database)
  await sql`
    alter trigger audit_events_repository_projection_write_guard on audit_events
    rename to project_audit_events_repository_projection_write_guard
  `.execute(database)
  await sql`
    alter trigger audit_events_append_only on audit_events
    rename to project_audit_events_append_only
  `.execute(database)
  await sql`
    alter function shipgate_reject_audit_mutation()
    rename to shipgate_reject_project_audit_mutation
  `.execute(database)
  await sql`
    create or replace function shipgate_reject_project_audit_mutation()
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
  await sql`alter table audit_events rename to project_audit_events`.execute(database)

  await sql`
    alter table project_audit_events enable trigger project_audit_events_repository_projection_write_guard;
    alter table project_audit_events enable trigger project_audit_events_append_only
  `.execute(database)
}
