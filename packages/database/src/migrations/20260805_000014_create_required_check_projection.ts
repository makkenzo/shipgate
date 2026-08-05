import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .alterTable('projects')
    .addColumn('required_check_policy_version', 'integer', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('required_check_overrides', 'jsonb', (column) =>
      column.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .execute()

  await database.schema
    .alterTable('projects')
    .addCheckConstraint(
      'projects_required_check_policy_version_check',
      sql`required_check_policy_version >= 0`,
    )
    .execute()

  await database.schema
    .alterTable('projects')
    .addCheckConstraint(
      'projects_required_check_overrides_check',
      sql`jsonb_typeof(required_check_overrides) = 'array'`,
    )
    .execute()

  await sql`alter table projects disable trigger projects_repository_projection_write_guard`.execute(
    database,
  )

  await sql`
    update projects as project
    set required_check_policy_version = coalesce(
      (
        select max(required.policy_version)
        from required_checks as required
        where required.project_id = project.id
      ),
      0
    )
  `.execute(database)

  await sql`alter table projects enable trigger projects_repository_projection_write_guard`.execute(
    database,
  )

  await database.schema.dropIndex('required_checks_identity_key').execute()

  await sql`
    alter table required_checks disable trigger required_checks_repository_projection_write_guard
  `.execute(database)

  await sql`
    delete from required_checks as duplicate
    using required_checks as retained
    where duplicate.id > retained.id
      and duplicate.project_id = retained.project_id
      and duplicate.policy_version = retained.policy_version
      and duplicate.context = retained.context
      and duplicate.integration_id is not distinct from retained.integration_id
      and duplicate.source = retained.source
      and duplicate.source_reference is not distinct from retained.source_reference
  `.execute(database)

  await sql`
    alter table required_checks enable trigger required_checks_repository_projection_write_guard
  `.execute(database)

  await database.schema
    .alterTable('required_checks')
    .dropConstraint('required_checks_type_check')
    .execute()

  await database.schema
    .alterTable('required_checks')
    .dropConstraint('required_checks_source_check')
    .execute()

  await database.schema.alterTable('required_checks').dropColumn('check_type').execute()

  await database.schema
    .alterTable('required_checks')
    .addCheckConstraint(
      'required_checks_source_check',
      sql`source in ('branch_protection', 'repository_ruleset', 'project_override')`,
    )
    .execute()

  await sql`
    create unique index required_checks_identity_key
      on required_checks (
        project_id,
        policy_version,
        context,
        coalesce(integration_id, ''),
        source,
        coalesce(source_reference, '')
      )
  `.execute(database)

  await database.schema
    .alterTable('required_checks')
    .addUniqueConstraint('required_checks_id_project_repository_policy_key', [
      'id',
      'project_id',
      'repository_id',
      'policy_version',
    ])
    .execute()

  await sql`
    alter table commit_check_results
    drop constraint commit_check_results_repository_commit_fkey
  `.execute(database)

  await database.schema
    .alterTable('commit_check_results')
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .execute()

  await database.schema
    .createTable('change_required_check_states')
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('change_id', 'text', (column) => column.notNull())
    .addColumn('required_check_id', 'text', (column) => column.notNull())
    .addColumn('policy_version', 'integer', (column) => column.notNull())
    .addColumn('commit_sha', 'text', (column) => column.notNull())
    .addColumn('state', 'text', (column) => column.notNull())
    .addColumn('evidence_ids', 'jsonb', (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('observed_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('change_required_check_states_pkey', [
      'change_id',
      'required_check_id',
    ])
    .addCheckConstraint(
      'change_required_check_states_policy_version_check',
      sql`policy_version > 0`,
    )
    .addCheckConstraint(
      'change_required_check_states_commit_sha_check',
      sql`commit_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'change_required_check_states_state_check',
      sql`state in ('pending', 'successful', 'failed', 'missing', 'stale')`,
    )
    .addCheckConstraint(
      'change_required_check_states_evidence_check',
      sql`jsonb_typeof(evidence_ids) = 'array'`,
    )
    .execute()

  await sql`
    alter table change_required_check_states
    add constraint change_required_check_states_project_repository_fkey
    foreign key (project_id, repository_id)
    references projects (id, repository_id)
    on delete cascade
  `.execute(database)

  await sql`
    alter table change_required_check_states
    add constraint change_required_check_states_change_fkey
    foreign key (change_id, project_id, repository_id)
    references changes (id, project_id, repository_id)
    on delete cascade
  `.execute(database)

  await sql`
    alter table change_required_check_states
    add constraint change_required_check_states_required_check_fkey
    foreign key (required_check_id, project_id, repository_id, policy_version)
    references required_checks (id, project_id, repository_id, policy_version)
    on delete cascade
  `.execute(database)

  await database.schema
    .createIndex('change_required_check_states_project_state_idx')
    .on('change_required_check_states')
    .columns(['project_id', 'state', 'change_id'])
    .execute()

  await sql`
    create trigger change_required_check_states_repository_projection_write_guard
    before insert or update or delete on change_required_check_states
    for each row
    execute function shipgate_assert_repository_projection_write()
  `.execute(database)

  await database.schema
    .alterTable('project_audit_events')
    .dropConstraint('project_audit_events_event_type_check')
    .execute()

  await database.schema
    .alterTable('project_audit_events')
    .addCheckConstraint(
      'project_audit_events_event_type_check',
      sql`
        event_type in (
          'project_created',
          'project_configuration_changed',
          'project_required_check_overrides_changed',
          'required_check_policy_changed',
          'required_check_policy_refreshed',
          'project_deletion_requested'
        )
      `,
    )
    .execute()
}

export const down: Migration['down'] = async (database) => {
  await sql`
    alter table project_audit_events disable trigger project_audit_events_append_only;
    alter table project_audit_events disable trigger project_audit_events_repository_projection_write_guard
  `.execute(database)

  await sql`
    delete from project_audit_events
    where event_type in (
      'project_required_check_overrides_changed',
      'required_check_policy_changed',
      'required_check_policy_refreshed'
    )
  `.execute(database)

  await sql`
    alter table project_audit_events enable trigger project_audit_events_repository_projection_write_guard;
    alter table project_audit_events enable trigger project_audit_events_append_only
  `.execute(database)

  await database.schema
    .alterTable('project_audit_events')
    .dropConstraint('project_audit_events_event_type_check')
    .execute()

  await database.schema
    .alterTable('project_audit_events')
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
    .execute()

  await database.schema.dropTable('change_required_check_states').execute()

  await database.schema
    .alterTable('required_checks')
    .dropConstraint('required_checks_id_project_repository_policy_key')
    .execute()

  await database.schema.alterTable('commit_check_results').dropColumn('updated_at').execute()

  await sql`
    alter table commit_check_results disable trigger commit_check_results_repository_projection_write_guard
  `.execute(database)

  await sql`
    delete from commit_check_results as result
    where not exists (
      select 1
      from repository_commits as commit
      where commit.project_id = result.project_id
        and commit.repository_id = result.repository_id
        and commit.sha = result.commit_sha
    )
  `.execute(database)

  await sql`
    alter table commit_check_results enable trigger commit_check_results_repository_projection_write_guard
  `.execute(database)

  await sql`
    alter table commit_check_results
    add constraint commit_check_results_repository_commit_fkey
    foreign key (project_id, repository_id, commit_sha)
    references repository_commits (project_id, repository_id, sha)
    on delete cascade
  `.execute(database)

  await database.schema.dropIndex('required_checks_identity_key').execute()

  await sql`
    alter table required_checks disable trigger required_checks_repository_projection_write_guard
  `.execute(database)

  await sql`
    delete from required_checks
    where source = 'project_override'
  `.execute(database)

  await database.schema
    .alterTable('required_checks')
    .dropConstraint('required_checks_source_check')
    .execute()

  await database.schema
    .alterTable('required_checks')
    .addColumn('check_type', 'text', (column) => column.notNull().defaultTo('commit_status'))
    .execute()

  await sql`
    update required_checks
    set check_type = case
      when integration_id is null then 'commit_status'
      else 'check_run'
    end
  `.execute(database)

  await database.schema
    .alterTable('required_checks')
    .alterColumn('check_type', (column) => column.dropDefault())
    .execute()

  await database.schema
    .alterTable('required_checks')
    .addCheckConstraint(
      'required_checks_type_check',
      sql`check_type in ('check_run', 'commit_status')`,
    )
    .execute()

  await database.schema
    .alterTable('required_checks')
    .addCheckConstraint(
      'required_checks_source_check',
      sql`source in ('branch_protection', 'repository_ruleset')`,
    )
    .execute()

  await sql`
    delete from required_checks as duplicate
    using required_checks as retained
    where duplicate.id > retained.id
      and duplicate.project_id = retained.project_id
      and duplicate.policy_version = retained.policy_version
      and duplicate.check_type = retained.check_type
      and duplicate.context = retained.context
      and duplicate.integration_id is not distinct from retained.integration_id
  `.execute(database)

  await sql`
    alter table required_checks enable trigger required_checks_repository_projection_write_guard
  `.execute(database)

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
    .alterTable('projects')
    .dropConstraint('projects_required_check_overrides_check')
    .execute()

  await database.schema
    .alterTable('projects')
    .dropConstraint('projects_required_check_policy_version_check')
    .execute()

  await database.schema
    .alterTable('projects')
    .dropColumn('required_check_overrides')
    .dropColumn('required_check_policy_version')
    .execute()
}
