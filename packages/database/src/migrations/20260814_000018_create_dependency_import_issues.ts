import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .createTable('release_planning_issues')
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('repository_id', 'text', (column) => column.notNull())
    .addColumn('category', 'text', (column) => column.notNull())
    .addColumn('entity_type', 'text', (column) => column.notNull())
    .addColumn('entity_id', 'text', (column) => column.notNull())
    .addColumn('pull_request_number', 'integer')
    .addColumn('code', 'text', (column) => column.notNull())
    .addColumn('message', 'text', (column) => column.notNull())
    .addColumn('body_hash', 'text')
    .addColumn('source', 'text', (column) => column.notNull())
    .addColumn('source_reference', 'text', (column) => column.notNull())
    .addColumn('payload', 'jsonb', (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('release_planning_issues_source_key', [
      'project_id',
      'category',
      'source_reference',
    ])
    .addCheckConstraint(
      'release_planning_issues_category_check',
      sql`category in ('dependency_managed_block')`,
    )
    .addCheckConstraint(
      'release_planning_issues_entity_check',
      sql`length(btrim(entity_type)) > 0 and length(btrim(entity_id)) > 0`,
    )
    .addCheckConstraint(
      'release_planning_issues_pull_request_check',
      sql`pull_request_number is null or pull_request_number > 0`,
    )
    .addCheckConstraint(
      'release_planning_issues_code_check',
      sql`code ~ '^[a-z][a-z0-9._:-]{0,127}$'`,
    )
    .addCheckConstraint(
      'release_planning_issues_message_check',
      sql`length(btrim(message)) > 0 and length(message) <= 4000`,
    )
    .addCheckConstraint(
      'release_planning_issues_body_hash_check',
      sql`body_hash is null or body_hash ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      'release_planning_issues_source_check',
      sql`source in ('github_webhook', 'user', 'system')`,
    )
    .addCheckConstraint(
      'release_planning_issues_source_reference_check',
      sql`length(btrim(source_reference)) > 0 and length(source_reference) <= 255`,
    )
    .execute()

  await sql`
    alter table release_planning_issues
    add constraint release_planning_issues_project_repository_fkey
    foreign key (project_id, repository_id)
    references projects (id, repository_id)
    on delete cascade
  `.execute(database)

  await database.schema
    .createIndex('release_planning_issues_project_created_idx')
    .on('release_planning_issues')
    .columns(['project_id', 'created_at'])
    .execute()

  await sql`
    create trigger release_planning_issues_repository_projection_write_guard
    before insert or update or delete on release_planning_issues
    for each row
    execute function shipgate_assert_repository_projection_write()
  `.execute(database)
}

export const down: Migration['down'] = async (database) => {
  await database.schema.dropTable('release_planning_issues').execute()
}
