import { type SqlBool, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .alterTable('projects')
    .addColumn('release_state_version', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('projection_version', 'integer', (column) => column.notNull().defaultTo(0))
    .execute()

  await sql`
    alter table projects
      add constraint projects_release_state_version_check
        check (release_state_version >= 0),
      add constraint projects_projection_version_check
        check (projection_version >= 0)
  `.execute(database)

  await database.schema
    .alterTable('release_candidates')
    .alterColumn('created_by_github_user_id', (column) => column.dropNotNull())
    .addColumn('evaluation_status', 'text', (column) => column.notNull().defaultTo('evaluating'))
    .execute()

  await sql`
    alter table release_candidates
    disable trigger release_candidates_repository_write_guard
  `.execute(database)
  await sql`
    update release_candidates as candidate
    set
      state = case
        when candidate.state = 'revision_active' then 'open'
        else candidate.state
      end,
      evaluation_status = coalesce(
        (
          select evaluation.result
          from release_candidate_evaluations as evaluation
          where evaluation.candidate_id = candidate.id
            and evaluation.evaluation_version = candidate.latest_evaluation_version
        ),
        'evaluating'
      )
  `.execute(database)
  await sql`
    alter table release_candidates
    enable trigger release_candidates_repository_write_guard
  `.execute(database)

  await database.schema
    .alterTable('release_candidates')
    .addCheckConstraint(
      'release_candidates_evaluation_status_check',
      sql`evaluation_status in ('evaluating', 'ready', 'blocked')`,
    )
    .execute()

  await database.schema
    .alterTable('release_candidate_evaluations')
    .addColumn('request_id', 'text')
    .addColumn('project_state_version', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('projection_version', 'integer', (column) => column.notNull().defaultTo(0))
    .execute()

  await sql`
    alter table release_candidate_evaluations
      add constraint release_candidate_evaluations_project_state_version_check
        check (project_state_version >= 0),
      add constraint release_candidate_evaluations_projection_version_check
        check (projection_version >= 0)
  `.execute(database)

  await database.schema
    .createTable('release_candidate_evaluation_requests')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('candidate_id', 'text', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull().defaultTo('queued'))
    .addColumn('project_state_version', 'integer', (column) => column.notNull())
    .addColumn('projection_version', 'integer', (column) => column.notNull())
    .addColumn('candidate_version', 'integer', (column) => column.notNull())
    .addColumn('configuration_version', 'integer', (column) => column.notNull())
    .addColumn('required_check_policy_version', 'integer', (column) => column.notNull())
    .addColumn('source_sha', 'text', (column) => column.notNull())
    .addColumn('production_sha', 'text', (column) => column.notNull())
    .addColumn('reasons', 'jsonb', (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('coalesced_count', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('attempt_count', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('last_error_code', 'text')
    .addColumn('last_error_message', 'text')
    .addColumn('requested_at', 'timestamptz', (column) => column.notNull())
    .addColumn('claimed_at', 'timestamptz')
    .addColumn('completed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('release_candidate_evaluation_requests_id_candidate_key', [
      'id',
      'candidate_id',
    ])
    .addCheckConstraint(
      'release_candidate_evaluation_requests_status_check',
      sql`status in ('queued', 'running', 'succeeded', 'superseded', 'failed')`,
    )
    .addCheckConstraint(
      'release_candidate_evaluation_requests_versions_check',
      sql`
        project_state_version >= 0
        and projection_version >= 0
        and candidate_version > 0
        and configuration_version > 0
        and required_check_policy_version >= 0
      `,
    )
    .addCheckConstraint(
      'release_candidate_evaluation_requests_source_sha_check',
      sql`source_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'release_candidate_evaluation_requests_production_sha_check',
      sql`production_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .addCheckConstraint(
      'release_candidate_evaluation_requests_reasons_check',
      sql`jsonb_typeof(reasons) = 'array' and jsonb_array_length(reasons) > 0`,
    )
    .addCheckConstraint(
      'release_candidate_evaluation_requests_counts_check',
      sql`coalesced_count >= 0 and attempt_count >= 0`,
    )
    .addCheckConstraint(
      'release_candidate_evaluation_requests_timestamps_check',
      sql`
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
          status in ('succeeded', 'superseded', 'failed')
          and completed_at is not null
        )
      `,
    )
    .execute()

  await sql`
    alter table release_candidate_evaluation_requests
    add constraint release_candidate_evaluation_requests_project_repository_fkey
    foreign key (project_id, repository_id)
    references projects (id, repository_id)
    on delete cascade
  `.execute(database)

  await sql`
    alter table release_candidate_evaluation_requests
    add constraint release_candidate_evaluation_requests_candidate_fkey
    foreign key (candidate_id, project_id, repository_id)
    references release_candidates (id, project_id, repository_id)
    on delete cascade
  `.execute(database)

  await database.schema
    .createIndex('release_candidate_evaluation_requests_one_queued_project_key')
    .unique()
    .on('release_candidate_evaluation_requests')
    .column('project_id')
    .where(sql<SqlBool>`status = 'queued'`)
    .execute()

  await database.schema
    .createIndex('release_candidate_evaluation_requests_runnable_idx')
    .on('release_candidate_evaluation_requests')
    .columns(['status', 'requested_at', 'project_id'])
    .where(sql<SqlBool>`status in ('queued', 'running')`)
    .execute()

  await database.schema
    .createIndex('release_candidate_evaluation_requests_candidate_idx')
    .on('release_candidate_evaluation_requests')
    .columns(['candidate_id', 'requested_at'])
    .execute()

  await database.schema
    .createIndex('release_candidate_evaluations_request_key')
    .unique()
    .on('release_candidate_evaluations')
    .column('request_id')
    .where(sql<SqlBool>`request_id is not null`)
    .execute()

  await sql`
    alter table release_candidate_evaluations
    add constraint release_candidate_evaluations_request_fkey
    foreign key (request_id, candidate_id)
    references release_candidate_evaluation_requests (id, candidate_id)
    on delete cascade
  `.execute(database)

  await sql`
    create trigger release_candidate_evaluation_requests_repository_write_guard
    before insert or update or delete on release_candidate_evaluation_requests
    for each row
    execute function shipgate_assert_repository_projection_write()
  `.execute(database)
}

export const down: Migration['down'] = async (database) => {
  await sql`
    alter table release_candidate_evaluations
    drop constraint release_candidate_evaluations_request_fkey
  `.execute(database)
  await database.schema.dropIndex('release_candidate_evaluations_request_key').execute()
  await database.schema.dropTable('release_candidate_evaluation_requests').execute()

  await sql`
    alter table release_candidate_evaluations
      drop constraint release_candidate_evaluations_projection_version_check,
      drop constraint release_candidate_evaluations_project_state_version_check
  `.execute(database)

  await database.schema
    .alterTable('release_candidate_evaluations')
    .dropColumn('projection_version')
    .dropColumn('project_state_version')
    .dropColumn('request_id')
    .execute()

  await sql`
    alter table release_candidates disable trigger release_candidates_repository_write_guard
  `.execute(database)
  await sql`
    update release_candidates
    set created_by_github_user_id = '1'
    where created_by_github_user_id is null
  `.execute(database)
  await sql`
    alter table release_candidates enable trigger release_candidates_repository_write_guard
  `.execute(database)

  await database.schema
    .alterTable('release_candidates')
    .dropConstraint('release_candidates_evaluation_status_check')
    .execute()
  await database.schema
    .alterTable('release_candidates')
    .dropColumn('evaluation_status')
    .alterColumn('created_by_github_user_id', (column) => column.setNotNull())
    .execute()

  await sql`
    alter table projects
      drop constraint projects_projection_version_check,
      drop constraint projects_release_state_version_check
  `.execute(database)
  await database.schema
    .alterTable('projects')
    .dropColumn('projection_version')
    .dropColumn('release_state_version')
    .execute()
}
