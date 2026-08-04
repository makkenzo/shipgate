import { type SqlBool, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema.alterTable('projects').addColumn('merge_base_sha', 'text').execute()

  await database.schema
    .alterTable('projects')
    .addCheckConstraint(
      'projects_merge_base_sha_check',
      sql`merge_base_sha is null or merge_base_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .execute()

  await sql`
    update projects
    set merge_base_sha = production_sha
    where production_sha is not null
  `.execute(database)

  await database.schema
    .alterTable('repository_commits')
    .addColumn('first_parent_position', 'integer')
    .addColumn('integration_point_sha', 'text')
    .addColumn('production_patch_equivalent', 'boolean', (column) =>
      column.notNull().defaultTo(false),
    )
    .addColumn('attribution_state', 'text', (column) => column.notNull().defaultTo('unmanaged'))
    .execute()

  /*
   * Stage 4.3 did not persist first-parent windows. Remove the old positional
   * claim before enabling topology checks; the next full sync restores the
   * complete ordered range atomically.
   */
  await sql`
    update repository_commits
    set source_delta_position = null
    where source_delta_position is not null
  `.execute(database)

  await database.schema
    .alterTable('repository_commits')
    .addCheckConstraint(
      'repository_commits_first_parent_position_check',
      sql`first_parent_position is null or first_parent_position >= 0`,
    )
    .execute()

  await database.schema
    .alterTable('repository_commits')
    .addCheckConstraint(
      'repository_commits_integration_point_sha_check',
      sql`integration_point_sha is null or integration_point_sha ~ '^[0-9a-f]{40,64}$'`,
    )
    .execute()

  await database.schema
    .alterTable('repository_commits')
    .addCheckConstraint(
      'repository_commits_attribution_state_check',
      sql`attribution_state in ('managed', 'unmanaged', 'ambiguous')`,
    )
    .execute()

  await database.schema
    .alterTable('repository_commits')
    .addCheckConstraint(
      'repository_commits_topology_shape_check',
      sql`
        (
          source_delta_position is null
          and first_parent_position is null
          and integration_point_sha is null
        )
        or
        (
          source_delta_position is not null
          and integration_point_sha is not null
          and (
            first_parent_position is null
            or integration_point_sha = sha
          )
        )
      `,
    )
    .execute()

  await sql`
    alter table repository_commits
    add constraint repository_commits_integration_point_fkey
    foreign key (project_id, repository_id, integration_point_sha)
    references repository_commits (project_id, repository_id, sha)
    deferrable initially deferred
  `.execute(database)

  await database.schema
    .createIndex('repository_commits_project_first_parent_position_key')
    .unique()
    .on('repository_commits')
    .columns(['project_id', 'first_parent_position'])
    .where(sql<SqlBool>`first_parent_position is not null`)
    .execute()

  await database.schema
    .createIndex('repository_commits_project_attribution_idx')
    .on('repository_commits')
    .columns(['project_id', 'attribution_state', 'source_delta_position'])
    .execute()

  await database.schema
    .alterTable('changes')
    .addColumn('integration_first_parent_sha', 'text')
    .addColumn('integration_second_parent_sha', 'text')
    .execute()

  /*
   * Existing Stage 4.3 snapshots do not contain enough topology evidence to
   * satisfy the new attribution invariants. Preserve their immutable PR
   * identity, but stop presenting the old heuristic attribution as known.
   * The next full synchronization will rebuild these rows deterministically.
   */
  await sql`
    update changes
    set
      synchronization_state = 'unknown',
      production_presence = 'unknown'
  `.execute(database)

  await sql`
    update repository_commits as commit
    set attribution_state = case
      when exists (
        select 1
        from change_commits as membership
        where membership.repository_id = commit.repository_id
          and membership.commit_sha = commit.sha
      ) then 'managed'
      else 'unmanaged'
    end
  `.execute(database)

  await sql`
    update projects
    set status = 'degraded'
    where last_successful_sync_at is not null
      and status = 'active'
  `.execute(database)

  await database.schema
    .alterTable('changes')
    .addCheckConstraint(
      'changes_integration_first_parent_sha_check',
      sql`
        integration_first_parent_sha is null
        or integration_first_parent_sha ~ '^[0-9a-f]{40,64}$'
      `,
    )
    .execute()

  await database.schema
    .alterTable('changes')
    .addCheckConstraint(
      'changes_integration_second_parent_sha_check',
      sql`
        integration_second_parent_sha is null
        or integration_second_parent_sha ~ '^[0-9a-f]{40,64}$'
      `,
    )
    .execute()

  await database.schema
    .alterTable('changes')
    .addCheckConstraint(
      'changes_merge_parent_shape_check',
      sql`
        synchronization_state = 'unknown'
        or
        (
          merge_method = 'merge'
          and merge_commit_sha is not null
          and source_integration_sha = merge_commit_sha
          and integration_first_parent_sha is not null
          and integration_second_parent_sha is not null
        )
        or
        (
          merge_method in ('squash', 'rebase', 'unknown')
          and source_integration_sha is not null
          and integration_first_parent_sha is not null
          and integration_second_parent_sha is null
        )
      `,
    )
    .execute()

  await database.schema
    .alterTable('changes')
    .dropConstraint('changes_production_presence_check')
    .execute()

  await sql`
    update changes
    set production_presence = case production_presence
      when 'present' then 'released'
      when 'missing' then 'unreleased'
      when 'not_applicable' then 'unknown'
      else production_presence
    end
  `.execute(database)

  await database.schema
    .alterTable('changes')
    .addCheckConstraint(
      'changes_production_presence_check',
      sql`production_presence in ('unreleased', 'partially_present', 'released', 'unknown')`,
    )
    .execute()

  await database.schema
    .alterTable('changes')
    .dropConstraint('changes_known_commit_set_check')
    .execute()

  await database.schema
    .alterTable('changes')
    .addCheckConstraint(
      'changes_known_commit_set_check',
      sql`
        synchronization_state = 'unknown'
        or
        (
          source_integration_sha is not null
          and commit_set_fingerprint is not null
        )
      `,
    )
    .execute()
}

export const down: Migration['down'] = async (database) => {
  await sql`
    update changes
    set
      synchronization_state = 'unknown',
      source_integration_sha = null,
      commit_set_fingerprint = null,
      production_presence = 'unknown'
    where
      synchronization_state = 'known'
      and merge_method = 'unknown'
  `.execute(database)

  await database.schema
    .alterTable('changes')
    .dropConstraint('changes_known_commit_set_check')
    .execute()

  await database.schema
    .alterTable('changes')
    .addCheckConstraint(
      'changes_known_commit_set_check',
      sql`
        synchronization_state = 'unknown'
        or
        (
          merge_method <> 'unknown'
          and source_integration_sha is not null
          and commit_set_fingerprint is not null
        )
      `,
    )
    .execute()

  await database.schema
    .alterTable('changes')
    .dropConstraint('changes_production_presence_check')
    .execute()

  await sql`
    update changes
    set production_presence = case production_presence
      when 'released' then 'present'
      when 'unreleased' then 'missing'
      when 'partially_present' then 'unknown'
      else production_presence
    end
  `.execute(database)

  await database.schema
    .alterTable('changes')
    .addCheckConstraint(
      'changes_production_presence_check',
      sql`production_presence in ('present', 'missing', 'unknown', 'not_applicable')`,
    )
    .execute()

  await database.schema
    .alterTable('changes')
    .dropConstraint('changes_merge_parent_shape_check')
    .execute()
  await database.schema
    .alterTable('changes')
    .dropConstraint('changes_integration_second_parent_sha_check')
    .execute()
  await database.schema
    .alterTable('changes')
    .dropConstraint('changes_integration_first_parent_sha_check')
    .execute()

  await database.schema.alterTable('changes').dropColumn('integration_second_parent_sha').execute()
  await database.schema.alterTable('changes').dropColumn('integration_first_parent_sha').execute()

  await database.schema.dropIndex('repository_commits_project_attribution_idx').execute()
  await database.schema.dropIndex('repository_commits_project_first_parent_position_key').execute()

  await sql`
    alter table repository_commits
    drop constraint repository_commits_integration_point_fkey
  `.execute(database)

  await database.schema
    .alterTable('repository_commits')
    .dropConstraint('repository_commits_topology_shape_check')
    .execute()

  await database.schema
    .alterTable('repository_commits')
    .dropConstraint('repository_commits_attribution_state_check')
    .execute()
  await database.schema
    .alterTable('repository_commits')
    .dropConstraint('repository_commits_integration_point_sha_check')
    .execute()
  await database.schema
    .alterTable('repository_commits')
    .dropConstraint('repository_commits_first_parent_position_check')
    .execute()

  await database.schema.alterTable('repository_commits').dropColumn('attribution_state').execute()
  await database.schema
    .alterTable('repository_commits')
    .dropColumn('production_patch_equivalent')
    .execute()
  await database.schema
    .alterTable('repository_commits')
    .dropColumn('integration_point_sha')
    .execute()
  await database.schema
    .alterTable('repository_commits')
    .dropColumn('first_parent_position')
    .execute()

  await database.schema
    .alterTable('projects')
    .dropConstraint('projects_merge_base_sha_check')
    .execute()

  await database.schema.alterTable('projects').dropColumn('merge_base_sha').execute()
}
