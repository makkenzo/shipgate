import { createDatabase, type DatabaseClient, migrateToLatest } from '@shipgate/database'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type {
  GitHubRepositoryAccessService,
  RepositoryAccessDecision,
} from '../src/github-access/index.js'
import {
  createProjectService,
  type ProjectTopologyValidator,
  withRepositoryTransaction,
} from '../src/projects/index.js'
import { archiveRepositoryProjectionInTransaction } from '../src/projects/store.js'

const actorGitHubUserId = 99
const sourceSha = 'a'.repeat(40)
const productionSha = 'b'.repeat(40)

interface QaFixture {
  readonly projectId: string
  readonly repositoryId: number
  readonly installationId: number
  readonly changeId: string
  readonly finalHeadSha: string
  readonly commitSetFingerprint: string
  readonly candidateId: string | null
}

describe.sequential('QA workflow', () => {
  let postgres: PostgresTestDatabase
  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    database = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: 'shipgate-qa-workflow-test',
      ssl: { mode: 'disable' },
      pool: {
        min: 0,
        max: 6,
        idleTimeoutMs: 5_000,
        connectionTimeoutMs: 5_000,
        maxLifetimeSeconds: 0,
      },
      allowExitOnIdle: true,
      onPoolError: () => undefined,
    })

    await migrateToLatest(database.kysely)
  }, 60_000)

  afterAll(async () => {
    await database.destroy()
    await postgres.stop()
  })

  it('records QA against the current code version and invalidates the active candidate once', async () => {
    const fixture = await seedQaFixture(database, 1, { candidate: true })
    const candidateId = requireCandidateId(fixture)
    const requiredPermissions: string[] = []
    const invalidatedUsers: number[] = []
    const service = createProjectService({
      database,
      githubRepositoryAccess: createAccessService('allowed', requiredPermissions, invalidatedUsers),
      topologyValidator: unusedTopologyValidator(),
    })

    const recorded = await service.setQaStatus({
      actorGitHubUserId,
      projectId: fixture.projectId,
      changeId: fixture.changeId,
      status: 'passed',
      comment: '  Validated on staging.  ',
      correlationId: 'qa:set:first',
    })

    expect(recorded).toMatchObject({
      status: 'recorded',
      qa: {
        status: 'passed',
        comment: 'Validated on staging.',
        actorGitHubUserId: String(actorGitHubUserId),
      },
      candidateReevaluation: {
        candidateId,
        candidateVersion: 1,
      },
    })
    expect(requiredPermissions).toEqual(['triage'])
    expect(invalidatedUsers).toEqual([actorGitHubUserId])

    const assessment = await database.kysely
      .selectFrom('change_qa_assessments')
      .selectAll()
      .where('change_id', '=', fixture.changeId)
      .executeTakeFirstOrThrow()

    expect(assessment).toMatchObject({
      final_head_sha: fixture.finalHeadSha,
      commit_set_fingerprint: fixture.commitSetFingerprint,
      sequence: 1,
      status: 'passed',
      previous_status: 'pending',
      reason_code: 'qa_status_set',
    })

    await expect(
      database.kysely
        .selectFrom('release_candidates')
        .select(['state', 'version', 'latest_evaluation_version'])
        .where('id', '=', candidateId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      state: 'open',
      version: 1,
      latest_evaluation_version: null,
    })

    await expect(
      database.kysely
        .selectFrom('candidate_exclusions')
        .select(['change_id', 'candidate_version'])
        .where('candidate_id', '=', candidateId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      change_id: fixture.changeId,
      candidate_version: 1,
    })

    await expect(
      database.kysely
        .selectFrom('audit_events')
        .select(['event_type', 'entity_type', 'entity_id', 'reason_code'])
        .where('entity_id', '=', assessment.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      event_type: 'qa_assessment_recorded',
      entity_type: 'qa_assessment',
      entity_id: assessment.id,
      reason_code: 'qa_status_set',
    })

    const repeated = await service.setQaStatus({
      actorGitHubUserId,
      projectId: fixture.projectId,
      changeId: fixture.changeId,
      status: 'passed',
      comment: 'Validated on staging.',
      correlationId: 'qa:set:repeat',
    })

    expect(repeated).toMatchObject({
      status: 'already_applied',
      candidateReevaluation: null,
      qa: { assessmentId: assessment.id, status: 'passed' },
    })
    expect(requiredPermissions).toEqual(['triage', 'triage'])
    expect(invalidatedUsers).toEqual([actorGitHubUserId, actorGitHubUserId])
    await expect(countRows(database, 'change_qa_assessments', fixture.changeId)).resolves.toBe(1)
    await expect(
      database.kysely
        .selectFrom('release_candidates')
        .select('version')
        .where('id', '=', candidateId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ version: 1 })

    const changes = await service.listChanges(actorGitHubUserId, fixture.projectId)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.qa).toMatchObject({
      assessmentId: assessment.id,
      status: 'passed',
      comment: 'Validated on staging.',
    })
  })

  it('resets QA by appending history and preserving the previous assessment', async () => {
    const fixture = await seedQaFixture(database, 2, { candidate: true })
    const service = createProjectService({
      database,
      githubRepositoryAccess: createAccessService('allowed'),
      topologyValidator: unusedTopologyValidator(),
    })

    await service.setQaStatus({
      actorGitHubUserId,
      projectId: fixture.projectId,
      changeId: fixture.changeId,
      status: 'failed',
      comment: 'Regression found.',
      correlationId: 'qa:failed',
    })
    const reset = await service.resetQaStatus({
      actorGitHubUserId,
      projectId: fixture.projectId,
      changeId: fixture.changeId,
      comment: 'Retest required after the fix.',
      correlationId: 'qa:reset',
    })

    expect(reset).toMatchObject({
      status: 'recorded',
      qa: {
        status: 'pending',
        comment: 'Retest required after the fix.',
      },
      candidateReevaluation: {
        candidateVersion: 1,
      },
    })

    const history = await database.kysely
      .selectFrom('change_qa_assessments')
      .select(['sequence', 'status', 'previous_status', 'reason_code'])
      .where('change_id', '=', fixture.changeId)
      .orderBy('sequence')
      .execute()

    expect(history).toEqual([
      {
        sequence: 1,
        status: 'failed',
        previous_status: 'pending',
        reason_code: 'qa_status_set',
      },
      {
        sequence: 2,
        status: 'pending',
        previous_status: 'failed',
        reason_code: 'qa_status_reset',
      },
    ])
    await expect(
      database.kysely
        .selectFrom('effective_change_qa_assessments')
        .select(['status', 'sequence'])
        .where('change_id', '=', fixture.changeId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'pending', sequence: 2 })
  })

  it('requires current Triage access and a stable current release-queue projection', async () => {
    const deniedFixture = await seedQaFixture(database, 3)
    const deniedService = createProjectService({
      database,
      githubRepositoryAccess: createAccessService('denied'),
      topologyValidator: unusedTopologyValidator(),
    })

    await expect(
      deniedService.setQaStatus({
        actorGitHubUserId,
        projectId: deniedFixture.projectId,
        changeId: deniedFixture.changeId,
        status: 'passed',
        correlationId: 'qa:denied',
      }),
    ).rejects.toMatchObject({ code: 'permission_missing' })
    await expect(
      countRows(database, 'change_qa_assessments', deniedFixture.changeId),
    ).resolves.toBe(0)

    const unknownFixture = await seedQaFixture(database, 4, { identity: 'unknown' })
    const allowedService = createProjectService({
      database,
      githubRepositoryAccess: createAccessService('allowed'),
      topologyValidator: unusedTopologyValidator(),
    })

    await expect(
      allowedService.setQaStatus({
        actorGitHubUserId,
        projectId: unknownFixture.projectId,
        changeId: unknownFixture.changeId,
        status: 'passed',
        correlationId: 'qa:unknown',
      }),
    ).rejects.toMatchObject({ code: 'change_identity_unknown' })
    await expect(
      countRows(database, 'change_qa_assessments', unknownFixture.changeId),
    ).resolves.toBe(0)

    const degradedFixture = await seedQaFixture(database, 6)
    await withRepositoryTransaction(
      database,
      degradedFixture.repositoryId,
      async ({ transaction }) => {
        await transaction
          .updateTable('projects')
          .set({ status: 'degraded', updated_at: new Date() })
          .where('id', '=', degradedFixture.projectId)
          .executeTakeFirstOrThrow()
      },
    )
    await expect(
      allowedService.setQaStatus({
        actorGitHubUserId,
        projectId: degradedFixture.projectId,
        changeId: degradedFixture.changeId,
        status: 'passed',
        correlationId: 'qa:degraded',
      }),
    ).rejects.toMatchObject({ code: 'project_not_active' })
  })

  it('makes QA effectively pending after head, commit-set, identity, or destructive-history changes', async () => {
    const fixture = await seedQaFixture(database, 5)
    const service = createProjectService({
      database,
      githubRepositoryAccess: createAccessService('allowed'),
      topologyValidator: unusedTopologyValidator(),
    })

    await service.setQaStatus({
      actorGitHubUserId,
      projectId: fixture.projectId,
      changeId: fixture.changeId,
      status: 'passed',
      correlationId: 'qa:auto-reset:first',
    })

    const changedHeadSha = 'd'.repeat(40)
    await updateChangeVersion(database, fixture, {
      finalHeadSha: changedHeadSha,
      commitSetFingerprint: fixture.commitSetFingerprint,
      synchronizationState: 'known',
      productionPresence: 'unreleased',
    })
    await expect(loadQa(service, fixture)).resolves.toMatchObject({
      status: 'pending',
      assessmentId: null,
    })

    await service.setQaStatus({
      actorGitHubUserId,
      projectId: fixture.projectId,
      changeId: fixture.changeId,
      status: 'passed',
      correlationId: 'qa:auto-reset:second',
    })

    const changedFingerprint = '2'.repeat(64)
    await updateChangeVersion(database, fixture, {
      finalHeadSha: changedHeadSha,
      commitSetFingerprint: changedFingerprint,
      synchronizationState: 'known',
      productionPresence: 'unreleased',
    })
    await expect(loadQa(service, fixture)).resolves.toMatchObject({
      status: 'pending',
      assessmentId: null,
    })

    await service.setQaStatus({
      actorGitHubUserId,
      projectId: fixture.projectId,
      changeId: fixture.changeId,
      status: 'passed',
      correlationId: 'qa:auto-reset:third',
    })
    await updateChangeVersion(database, fixture, {
      finalHeadSha: changedHeadSha,
      commitSetFingerprint: null,
      synchronizationState: 'unknown',
      productionPresence: 'unknown',
    })
    await expect(loadQa(service, fixture)).resolves.toMatchObject({
      status: 'pending',
      assessmentId: null,
    })

    const restoredFingerprint = '3'.repeat(64)
    await updateChangeVersion(database, fixture, {
      finalHeadSha: changedHeadSha,
      commitSetFingerprint: restoredFingerprint,
      synchronizationState: 'known',
      productionPresence: 'unreleased',
    })
    const fourth = await service.setQaStatus({
      actorGitHubUserId,
      projectId: fixture.projectId,
      changeId: fixture.changeId,
      status: 'passed',
      correlationId: 'qa:auto-reset:fourth',
    })
    const assessedAt = fourth.qa.assessedAt

    if (!assessedAt) {
      throw new Error('Expected a recorded QA assessment timestamp')
    }

    const archives = await archiveDestructiveProjection(
      database,
      fixture,
      new Date(assessedAt.getTime() + 1),
    )

    expect(archives.secondArchiveId).toBe(archives.firstArchiveId)

    await expect(loadQa(service, fixture)).resolves.toMatchObject({
      status: 'pending',
      assessmentId: null,
    })
    await expect(
      database.kysely
        .selectFrom('projects')
        .select(['status', 'qa_reset_epoch'])
        .where('id', '=', fixture.projectId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'degraded', qa_reset_epoch: 1 })
    await expect(countRows(database, 'change_qa_assessments', fixture.changeId)).resolves.toBe(4)
  })
})

async function seedQaFixture(
  database: DatabaseClient,
  index: number,
  options: {
    readonly candidate?: boolean
    readonly identity?: 'known' | 'unknown'
  } = {},
): Promise<QaFixture> {
  const projectId = `qa-project-${index}`
  const repositoryId = 92_000 + index
  const installationId = 91_000 + index
  const changeId = `qa-change-${index}`
  const candidateId = options.candidate ? `qa-candidate-${index}` : null
  const finalHeadSha = `${index}`.repeat(40)
  const commitSetFingerprint = `${index}`.repeat(64)
  const identity = options.identity ?? 'known'
  const now = new Date(`2026-08-12T1${index}:00:00.000Z`)

  await withRepositoryTransaction(database, repositoryId, async ({ transaction }) => {
    await transaction
      .insertInto('projects')
      .values({
        id: projectId,
        installation_id: String(installationId),
        repository_id: String(repositoryId),
        owner_id: String(actorGitHubUserId),
        owner_login: 'octocat',
        repository_name: `shipgate-${index}`,
        repository_full_name: `octocat/shipgate-${index}`,
        default_branch: 'main',
        source_branch: 'develop',
        production_branch: 'main',
        status: 'active',
        source_sha: sourceSha,
        production_sha: productionSha,
        last_successful_sync_at: now,
        merge_base_sha: productionSha,
        configuration_version: 1,
        required_check_policy_version: 0,
        required_check_overrides: '[]',
        deletion_requested_at: null,
        deleted_at: null,
        updated_at: now,
      })
      .execute()
    await transaction
      .insertInto('changes')
      .values({
        id: changeId,
        project_id: projectId,
        repository_id: String(repositoryId),
        github_pull_request_id: String(50_000 + index),
        pull_request_number: 100 + index,
        title: `QA change ${index}`,
        url: `https://github.com/octocat/shipgate-${index}/pull/${100 + index}`,
        author_id: String(actorGitHubUserId),
        author_login: 'octocat',
        base_branch: 'develop',
        merged_at: now,
        final_head_sha: finalHeadSha,
        merge_commit_sha: finalHeadSha,
        source_integration_sha: finalHeadSha,
        integration_first_parent_sha: productionSha,
        integration_second_parent_sha: null,
        merge_method: 'squash',
        commit_set_fingerprint: identity === 'known' ? commitSetFingerprint : null,
        synchronization_state: identity,
        production_presence: identity === 'known' ? 'unreleased' : 'unknown',
        observed_at: now,
        updated_at: now,
      })
      .execute()

    if (candidateId) {
      await transaction
        .insertInto('release_candidates')
        .values({
          id: candidateId,
          project_id: projectId,
          repository_id: String(repositoryId),
          sequence: 1,
          state: 'open',
          version: 1,
          created_by_github_user_id: String(actorGitHubUserId),
          note: null,
          latest_evaluation_version: null,
          closed_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute()
      await transaction
        .insertInto('candidate_exclusions')
        .values({
          candidate_id: candidateId,
          project_id: projectId,
          repository_id: String(repositoryId),
          change_id: changeId,
          actor_github_user_id: String(actorGitHubUserId),
          reason: 'Deferred from the current release.',
          candidate_version: 1,
          created_at: now,
          updated_at: now,
        })
        .execute()
      await transaction
        .insertInto('release_candidate_evaluations')
        .values({
          id: `qa-evaluation-${index}`,
          candidate_id: candidateId,
          project_id: projectId,
          repository_id: String(repositoryId),
          evaluation_version: 1,
          candidate_version: 1,
          configuration_version: 1,
          source_sha: sourceSha,
          production_sha: productionSha,
          projection_fingerprint: 'f'.repeat(64),
          required_check_policy_version: 0,
          result: 'blocked',
          evaluation_fingerprint: 'e'.repeat(64),
          summary: JSON.stringify({ ready: 0, blocked: 1 }),
          blockers: JSON.stringify([{ code: 'qa_pending', changeId }]),
          evaluated_at: now,
          created_at: now,
        })
        .execute()
      await transaction
        .updateTable('release_candidates')
        .set({ latest_evaluation_version: 1, updated_at: now })
        .where('id', '=', candidateId)
        .executeTakeFirstOrThrow()
    }
  })

  return {
    projectId,
    repositoryId,
    installationId,
    changeId,
    finalHeadSha,
    commitSetFingerprint,
    candidateId,
  }
}

async function archiveDestructiveProjection(
  database: DatabaseClient,
  fixture: QaFixture,
  detectedAt: Date,
): Promise<{ readonly firstArchiveId: string; readonly secondArchiveId: string }> {
  const syncRunId = `qa-destructive-sync-${fixture.projectId}`
  const reconciliationRequestId = `qa-destructive-request-${fixture.projectId}`

  return withRepositoryTransaction(database, fixture.repositoryId, async (scope) => {
    await scope.transaction
      .insertInto('repository_sync_runs')
      .values({
        id: syncRunId,
        project_id: fixture.projectId,
        repository_id: String(fixture.repositoryId),
        reason: 'force_push_detected',
        status: 'running',
        configuration_version: 1,
        idempotency_key: `qa-destructive-${fixture.projectId}`,
        projection_fingerprint: null,
        source_sha: sourceSha,
        production_sha: productionSha,
        started_at: detectedAt,
        completed_at: null,
        error_code: null,
        error_message: null,
        reconciliation_classification: null,
        difference_summary: null,
      })
      .execute()
    await scope.transaction
      .insertInto('repository_reconciliation_requests')
      .values({
        id: reconciliationRequestId,
        sync_run_id: syncRunId,
        project_id: fixture.projectId,
        repository_id: String(fixture.repositoryId),
        configuration_version: 1,
        reason: 'force_push_detected',
        mode: 'full',
        status: 'running',
        requested_by_github_user_id: null,
        source_sha: sourceSha,
        production_sha: productionSha,
        idempotency_key: `qa-destructive-${fixture.projectId}`,
        superseded_by_request_id: null,
        attempt_count: 1,
        last_error_code: null,
        last_error_message: null,
        requested_at: detectedAt,
        claimed_at: detectedAt,
        completed_at: null,
        trigger_scope: JSON.stringify({ reasons: ['force_push_detected'] }),
        force_push: true,
        coalesced_count: 0,
        updated_at: detectedAt,
      })
      .execute()

    const firstArchiveId = await archiveRepositoryProjectionInTransaction(scope, {
      reconciliationRequestId,
      syncRunId,
      projectId: fixture.projectId,
      repositoryId: String(fixture.repositoryId),
      archivedAt: detectedAt,
    })
    await scope.transaction
      .updateTable('projects')
      .set({ status: 'degraded', updated_at: detectedAt })
      .where('id', '=', fixture.projectId)
      .where('configuration_version', '=', 1)
      .where('status', 'in', ['initializing', 'active', 'degraded', 'disconnected'])
      .execute()

    const secondArchiveId = await archiveRepositoryProjectionInTransaction(scope, {
      reconciliationRequestId,
      syncRunId,
      projectId: fixture.projectId,
      repositoryId: String(fixture.repositoryId),
      archivedAt: new Date(detectedAt.getTime() + 1),
    })

    return { firstArchiveId, secondArchiveId }
  })
}

async function updateChangeVersion(
  database: DatabaseClient,
  fixture: QaFixture,
  input: {
    readonly finalHeadSha: string
    readonly commitSetFingerprint: string | null
    readonly synchronizationState: 'known' | 'unknown'
    readonly productionPresence: 'unreleased' | 'unknown'
  },
): Promise<void> {
  await withRepositoryTransaction(database, fixture.repositoryId, async ({ transaction }) => {
    await transaction
      .updateTable('changes')
      .set({
        final_head_sha: input.finalHeadSha,
        merge_commit_sha: input.finalHeadSha,
        source_integration_sha: input.finalHeadSha,
        commit_set_fingerprint: input.commitSetFingerprint,
        synchronization_state: input.synchronizationState,
        production_presence: input.productionPresence,
        observed_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', fixture.changeId)
      .executeTakeFirstOrThrow()
  })
}

async function loadQa(service: ReturnType<typeof createProjectService>, fixture: QaFixture) {
  const changes = await service.listChanges(actorGitHubUserId, fixture.projectId)

  if (!changes[0]) {
    throw new Error(`Expected change ${fixture.changeId} in release queue`)
  }

  return changes[0].qa
}

async function countRows(
  database: DatabaseClient,
  table: 'change_qa_assessments',
  changeId: string,
): Promise<number> {
  const row = await database.kysely
    .selectFrom(table)
    .select(({ fn }) => fn.countAll().as('count'))
    .where('change_id', '=', changeId)
    .executeTakeFirstOrThrow()

  return Number(row.count)
}

function requireCandidateId(fixture: QaFixture): string {
  if (!fixture.candidateId) {
    throw new Error(`Expected an active candidate for ${fixture.projectId}`)
  }

  return fixture.candidateId
}

function createAccessService(
  outcome: 'allowed' | 'denied',
  requiredPermissions: string[] = [],
  invalidatedUsers: number[] = [],
): GitHubRepositoryAccessService {
  return {
    async reconcileUserInstallations() {
      return []
    },
    async authorizeRepositoryAccess(input): Promise<RepositoryAccessDecision> {
      requiredPermissions.push(input.requiredPermission.repository)

      return {
        allowed: outcome === 'allowed',
        reason: outcome === 'allowed' ? 'allowed' : 'insufficient_repository_permission',
        githubUserId: input.githubUserId,
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        repositoryPermission: outcome === 'allowed' ? 'triage' : 'read',
        requiredPermission: input.requiredPermission,
        verifiedAt: new Date(),
        cacheExpiresAt: new Date(Date.now() + 60_000),
      }
    },
    invalidateAll() {},
    invalidateInstallation() {},
    invalidateUser(githubUserId) {
      invalidatedUsers.push(githubUserId)
    },
  }
}

function unusedTopologyValidator(): ProjectTopologyValidator {
  return {
    async validate() {
      throw new Error('Topology validation is not used by QA workflow tests')
    },
  }
}
