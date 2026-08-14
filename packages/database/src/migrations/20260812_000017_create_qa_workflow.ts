import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const up: Migration['up'] = async (database) => {
  await database.schema
    .alterTable('projects')
    .addColumn('qa_reset_epoch', 'integer', (column) => column.notNull().defaultTo(0))
    .execute()
  await database.schema
    .alterTable('projects')
    .addCheckConstraint('projects_qa_reset_epoch_check', sql`qa_reset_epoch >= 0`)
    .execute()

  await database.schema
    .alterTable('change_qa_assessments')
    .addColumn('qa_reset_epoch', 'integer', (column) => column.notNull().defaultTo(0))
    .execute()
  await database.schema
    .alterTable('change_qa_assessments')
    .addCheckConstraint('change_qa_assessments_qa_reset_epoch_check', sql`qa_reset_epoch >= 0`)
    .execute()

  await sql`drop view effective_change_qa_assessments`.execute(database)

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
      assessment.qa_reset_epoch,
      assessment.created_at
    from change_qa_assessments as assessment
    inner join changes as change
      on change.id = assessment.change_id
      and change.project_id = assessment.project_id
      and change.repository_id = assessment.repository_id
      and change.final_head_sha = assessment.final_head_sha
      and change.commit_set_fingerprint = assessment.commit_set_fingerprint
    inner join projects as project
      on project.id = assessment.project_id
      and project.repository_id = assessment.repository_id
      and project.qa_reset_epoch = assessment.qa_reset_epoch
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

  await database.schema
    .alterTable('change_qa_assessments')
    .dropConstraint('change_qa_assessments_qa_reset_epoch_check')
    .execute()
  await database.schema.alterTable('change_qa_assessments').dropColumn('qa_reset_epoch').execute()
  await database.schema
    .alterTable('projects')
    .dropConstraint('projects_qa_reset_epoch_check')
    .execute()
  await database.schema.alterTable('projects').dropColumn('qa_reset_epoch').execute()
}
