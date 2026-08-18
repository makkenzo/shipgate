import {
  createDatabase,
  type DatabaseClient,
  type JsonValue,
  migrateToLatest,
} from '@shipgate/database'
import { migrateJobQueue, type StructuredLogger } from '@shipgate/jobs'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type {
  GitHubRepositoryAccessService,
  RepositoryAccessDecision,
} from '../src/github-access/index.js'
import {
  createCandidateService,
  createReleaseCandidateEvaluationHandler,
  recoverActiveDraftCandidateEvaluations,
  touchProjectReleaseStateAndQueueEvaluation,
  withRepositoryTransaction,
} from '../src/projects/index.js'

const projectId = 'active-candidate-project'
const installationId = 51_001
const repositoryId = 61_001
const actorGitHubUserId = 99
const sourceSha = 'a'.repeat(40)
const productionSha = 'b'.repeat(40)
const changeAHead = 'c'.repeat(40)
const changeBHead = 'd'.repeat(40)
const changeAId = 'active-candidate-change-a'
const changeBId = 'active-candidate-change-b'
const observedAt = new Date('2026-08-15T10:00:00.000Z')

const logger: StructuredLogger = {
  child() {
    return logger
  },
  debug() {},
  info() {},
  warn() {},
  error() {},
}

describe.sequential('Active draft release candidate', () => {
  let postgres: PostgresTestDatabase
  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    database = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: 'shipgate-active-candidate-test',
      ssl: { mode: 'disable' },
      pool: {
        min: 0,
        max: 8,
        idleTimeoutMs: 5_000,
        connectionTimeoutMs: 5_000,
        maxLifetimeSeconds: 0,
      },
      allowExitOnIdle: true,
      onPoolError: () => undefined,
    })

    await migrateJobQueue(database)
    await migrateToLatest(database.kysely)
    await seedProject(database)
  }, 60_000)

  afterAll(async () => {
    await database.destroy()
    await postgres.stop()
  })

  it('creates one automatic candidate and coalesces release-state changes by Project', async () => {
    await expect(recoverActiveDraftCandidateEvaluations(database)).resolves.toEqual({
      projects: 1,
      jobs: 1,
    })

    const candidate = await database.kysely
      .selectFrom('release_candidates')
      .select(['id', 'state', 'version', 'created_by_github_user_id', 'evaluation_status'])
      .where('project_id', '=', projectId)
      .executeTakeFirstOrThrow()

    expect(candidate).toMatchObject({
      state: 'open',
      version: 1,
      created_by_github_user_id: null,
      evaluation_status: 'evaluating',
    })

    for (const reason of [
      'qa_changed',
      'check_result_changed',
      'check_result_changed',
      'dependencies_changed',
    ] as const) {
      await withRepositoryTransaction(database, repositoryId, async (scope) => {
        await touchProjectReleaseStateAndQueueEvaluation(scope, {
          projectId,
          repositoryId: String(repositoryId),
          reason,
        })
      })
    }

    const requests = await database.kysely
      .selectFrom('release_candidate_evaluation_requests')
      .select(['id', 'status', 'reasons', 'coalesced_count'])
      .where('project_id', '=', projectId)
      .execute()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      status: 'queued',
      coalesced_count: 4,
    })
    expect(requests[0]?.reasons).toEqual([
      'check_result_changed',
      'dependencies_changed',
      'qa_changed',
      'worker_recovery',
    ])

    const jobs = await database.kysely
      .selectFrom('shipgate_job_execution')
      .select('graphile_job_id')
      .where('task_identifier', '=', 'release.evaluate-candidate')
      .execute()

    expect(jobs).toHaveLength(1)
  })

  it('keeps dependents included when a prerequisite is excluded and restores readiness explicitly', async () => {
    const service = createCandidateService({
      database,
      githubRepositoryAccess: allowedAccessService(),
    })
    const excluded = await service.exclude({
      actorGitHubUserId,
      projectId,
      changeId: changeBId,
      reason: 'Hold prerequisite for another release',
      correlationId: 'candidate:test:exclude',
    })

    expect(excluded).toMatchObject({ status: 'recorded', excluded: true, changeId: changeBId })

    const blockedRequestId = await loadQueuedRequestId(database)
    const handler = createReleaseCandidateEvaluationHandler({ database })
    const blockedResult = await handler(execution(blockedRequestId))

    expect(blockedResult).toMatchObject({ status: 'published', result: 'blocked' })

    const blockedCandidate = await service.get({ actorGitHubUserId, projectId })
    const blockedSummary = asRecord(blockedCandidate?.latestEvaluation?.summary)
    const includedChanges = asArray(blockedSummary.includedChanges)
    const excludedChanges = asArray(blockedSummary.excludedChanges)
    const blockers = asArray(blockedSummary.blockers)

    expect(blockedCandidate).toMatchObject({ status: 'blocked', version: 2 })
    expect(includedChanges).toEqual(
      expect.arrayContaining([expect.objectContaining({ changeId: changeAId })]),
    )
    expect(excludedChanges).toEqual(
      expect.arrayContaining([expect.objectContaining({ changeId: changeBId })]),
    )
    expect(blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'dependency_excluded',
          changeId: changeAId,
          dependencyChangeId: changeBId,
        }),
      ]),
    )

    const restored = await service.restore({
      actorGitHubUserId,
      projectId,
      changeId: changeBId,
      correlationId: 'candidate:test:restore',
    })

    expect(restored).toMatchObject({ status: 'recorded', excluded: false, changeId: changeBId })

    const readyRequestId = await loadQueuedRequestId(database)
    const readyResult = await handler(execution(readyRequestId))

    expect(readyResult).toMatchObject({ status: 'published', result: 'ready' })

    const readyCandidate = await service.get({ actorGitHubUserId, projectId })

    expect(readyCandidate).toMatchObject({
      status: 'ready',
      version: 3,
      latestEvaluationVersion: 2,
      exclusions: [],
    })

    const auditEvents = await database.kysely
      .selectFrom('audit_events')
      .select('event_type')
      .where('project_id', '=', projectId)
      .where('event_type', 'in', ['change_excluded', 'change_restored', 'candidate_status_changed'])
      .orderBy('occurred_at')
      .execute()

    expect(auditEvents.map((event) => event.event_type)).toEqual([
      'change_excluded',
      'change_restored',
      'candidate_status_changed',
    ])
  })

  it('discards a stale worker result and publishes only the successor request', async () => {
    await withRepositoryTransaction(database, repositoryId, async (scope) => {
      await touchProjectReleaseStateAndQueueEvaluation(scope, {
        projectId,
        repositoryId: String(repositoryId),
        reason: 'qa_changed',
      })
    })

    const staleRequestId = await loadQueuedRequestId(database)
    let changed = false
    const staleHandler = createReleaseCandidateEvaluationHandler({
      database,
      async beforePublish() {
        if (changed) return
        changed = true

        await withRepositoryTransaction(database, repositoryId, async (scope) => {
          await touchProjectReleaseStateAndQueueEvaluation(scope, {
            projectId,
            repositoryId: String(repositoryId),
            reason: 'check_result_changed',
          })
        })
      },
    })

    await expect(staleHandler(execution(staleRequestId))).resolves.toMatchObject({
      status: 'discarded',
      requestId: staleRequestId,
      reason: 'state_changed_during_evaluation',
    })

    const staleRequest = await database.kysely
      .selectFrom('release_candidate_evaluation_requests')
      .select('status')
      .where('id', '=', staleRequestId)
      .executeTakeFirstOrThrow()
    const evaluationsBeforeSuccessor = await database.kysely
      .selectFrom('release_candidate_evaluations')
      .select('evaluation_version')
      .where('project_id', '=', projectId)
      .orderBy('evaluation_version')
      .execute()

    expect(staleRequest.status).toBe('superseded')
    expect(evaluationsBeforeSuccessor.map((evaluation) => evaluation.evaluation_version)).toEqual([
      1, 2,
    ])

    const successorRequestId = await loadQueuedRequestId(database)
    const successorHandler = createReleaseCandidateEvaluationHandler({ database })

    await expect(successorHandler(execution(successorRequestId))).resolves.toMatchObject({
      status: 'published',
      evaluationVersion: 3,
      result: 'ready',
    })
  })

  it('does not enqueue a redundant evaluation when a newer worker already published current state', async () => {
    await withRepositoryTransaction(database, repositoryId, async (scope) => {
      await touchProjectReleaseStateAndQueueEvaluation(scope, {
        projectId,
        repositoryId: String(repositoryId),
        reason: 'qa_changed',
      })
    })

    const olderRequestId = await loadQueuedRequestId(database)
    let notifyOlderPaused: (() => void) | undefined
    let releaseOlder: (() => void) | undefined
    const olderPaused = new Promise<void>((resolve) => {
      notifyOlderPaused = resolve
    })
    const continueOlder = new Promise<void>((resolve) => {
      releaseOlder = resolve
    })
    const olderHandler = createReleaseCandidateEvaluationHandler({
      database,
      async beforePublish() {
        notifyOlderPaused?.()
        await continueOlder
      },
    })
    const olderResult = olderHandler(execution(olderRequestId))

    await olderPaused
    await withRepositoryTransaction(database, repositoryId, async (scope) => {
      await touchProjectReleaseStateAndQueueEvaluation(scope, {
        projectId,
        repositoryId: String(repositoryId),
        reason: 'check_result_changed',
      })
    })

    const newerRequestId = await loadQueuedRequestId(database)
    const newerHandler = createReleaseCandidateEvaluationHandler({ database })

    await expect(newerHandler(execution(newerRequestId))).resolves.toMatchObject({
      status: 'published',
      evaluationVersion: 4,
      result: 'ready',
    })

    releaseOlder?.()
    await expect(olderResult).resolves.toMatchObject({
      status: 'discarded',
      requestId: olderRequestId,
      reason: 'state_changed_during_evaluation',
    })

    const activeRequests = await database.kysely
      .selectFrom('release_candidate_evaluation_requests')
      .select('id')
      .where('project_id', '=', projectId)
      .where('status', 'in', ['queued', 'running'])
      .execute()
    const evaluations = await database.kysely
      .selectFrom('release_candidate_evaluations')
      .select('evaluation_version')
      .where('project_id', '=', projectId)
      .orderBy('evaluation_version')
      .execute()

    expect(activeRequests).toEqual([])
    expect(evaluations.map((evaluation) => evaluation.evaluation_version)).toEqual([1, 2, 3, 4])
  })
})

async function seedProject(database: DatabaseClient): Promise<void> {
  await database.kysely
    .insertInto('github_installations')
    .values({
      installation_id: String(installationId),
      owner_id: String(actorGitHubUserId),
      owner_type: 'User',
      owner_login: 'octocat',
      owner_avatar_url: null,
      repository_selection: 'selected',
      suspended_at: null,
      permission_state: 'current',
      lifecycle_state: 'active',
      deletion_requested_at: null,
      deleted_at: null,
      last_successful_confirmation_at: observedAt,
      last_reconciled_at: observedAt,
      updated_at: observedAt,
    })
    .execute()
  await database.kysely
    .insertInto('github_installation_repositories')
    .values({
      installation_id: String(installationId),
      repository_id: String(repositoryId),
      owner_id: String(actorGitHubUserId),
      owner_login: 'octocat',
      name: 'active-candidate-fixture',
      full_name: 'octocat/active-candidate-fixture',
      private: true,
      archived: false,
      disabled: false,
      default_branch: 'main',
      visibility: 'private',
      last_successful_confirmation_at: observedAt,
      last_reconciled_at: observedAt,
      updated_at: observedAt,
    })
    .execute()

  await withRepositoryTransaction(database, repositoryId, async ({ transaction }) => {
    await transaction
      .insertInto('projects')
      .values({
        id: projectId,
        installation_id: String(installationId),
        repository_id: String(repositoryId),
        owner_id: String(actorGitHubUserId),
        owner_login: 'octocat',
        repository_name: 'active-candidate-fixture',
        repository_full_name: 'octocat/active-candidate-fixture',
        default_branch: 'main',
        source_branch: 'develop',
        production_branch: 'main',
        status: 'active',
        source_sha: sourceSha,
        production_sha: productionSha,
        last_successful_sync_at: observedAt,
        merge_base_sha: productionSha,
        configuration_version: 1,
        required_check_policy_version: 0,
        required_check_overrides: '[]',
        deletion_requested_at: null,
        deleted_at: null,
        updated_at: observedAt,
      })
      .execute()
    await transaction
      .insertInto('repository_commits')
      .values([commitRow(changeAHead, 0), commitRow(changeBHead, 1)])
      .execute()
    await transaction
      .insertInto('changes')
      .values([changeRow(changeAId, 101, changeAHead), changeRow(changeBId, 102, changeBHead)])
      .execute()
    await transaction
      .insertInto('change_commits')
      .values([membershipRow(changeAId, changeAHead), membershipRow(changeBId, changeBHead)])
      .execute()
    await transaction
      .insertInto('change_qa_assessments')
      .values([
        qaRow('active-candidate-qa-a', changeAId, changeAHead),
        qaRow('active-candidate-qa-b', changeBId, changeBHead),
      ])
      .execute()
    await transaction
      .insertInto('change_dependencies')
      .values({
        project_id: projectId,
        repository_id: String(repositoryId),
        dependent_change_id: changeAId,
        prerequisite_change_id: changeBId,
        source: 'user',
        actor_github_user_id: String(actorGitHubUserId),
        comment: null,
        version: 1,
        created_at: observedAt,
        updated_at: observedAt,
      })
      .execute()
    await transaction
      .insertInto('repository_sync_runs')
      .values({
        id: 'active-candidate-sync-run',
        project_id: projectId,
        repository_id: String(repositoryId),
        reason: 'fixture',
        status: 'succeeded',
        configuration_version: 1,
        idempotency_key: 'active-candidate-fixture',
        projection_fingerprint: 'f'.repeat(64),
        source_sha: sourceSha,
        production_sha: productionSha,
        started_at: observedAt,
        completed_at: observedAt,
        error_code: null,
        error_message: null,
        reconciliation_classification: 'expected_change',
        difference_summary: JSON.stringify({ fixture: true }),
      })
      .execute()
  })
}

function commitRow(sha: string, position: number) {
  return {
    project_id: projectId,
    repository_id: String(repositoryId),
    sha,
    tree_sha: '1'.repeat(40),
    message: `candidate commit ${position}`,
    author_id: String(actorGitHubUserId),
    author_login: 'octocat',
    author_name: 'The Octocat',
    author_email: 'octocat@example.test',
    committer_id: String(actorGitHubUserId),
    committer_login: 'octocat',
    authored_at: observedAt,
    committed_at: observedAt,
    parent_shas: JSON.stringify([position === 0 ? productionSha : changeAHead]),
    source_delta_position: position,
    first_parent_position: position,
    integration_point_sha: sha,
    production_patch_equivalent: false,
    attribution_state: 'managed' as const,
    observed_at: observedAt,
    updated_at: observedAt,
  }
}

function changeRow(id: string, pullRequestNumber: number, finalHeadSha: string) {
  return {
    id,
    project_id: projectId,
    repository_id: String(repositoryId),
    github_pull_request_id: String(100_000 + pullRequestNumber),
    pull_request_number: pullRequestNumber,
    title: `Candidate PR ${pullRequestNumber}`,
    url: `https://github.example/octocat/repository/pull/${pullRequestNumber}`,
    author_id: String(actorGitHubUserId),
    author_login: 'octocat',
    base_branch: 'develop',
    merged_at: new Date(observedAt.getTime() + pullRequestNumber),
    final_head_sha: finalHeadSha,
    merge_commit_sha: finalHeadSha,
    source_integration_sha: finalHeadSha,
    integration_first_parent_sha: productionSha,
    integration_second_parent_sha: null,
    merge_method: 'squash' as const,
    commit_set_fingerprint: finalHeadSha.padEnd(64, finalHeadSha[0]),
    synchronization_state: 'known' as const,
    production_presence: 'unreleased' as const,
    observed_at: observedAt,
    updated_at: observedAt,
  }
}

function membershipRow(changeId: string, commitSha: string) {
  return {
    project_id: projectId,
    repository_id: String(repositoryId),
    change_id: changeId,
    commit_sha: commitSha,
    position: 0,
  }
}

function qaRow(id: string, changeId: string, finalHeadSha: string) {
  return {
    id,
    project_id: projectId,
    repository_id: String(repositoryId),
    change_id: changeId,
    final_head_sha: finalHeadSha,
    commit_set_fingerprint: finalHeadSha.padEnd(64, finalHeadSha[0]),
    sequence: 1,
    status: 'passed' as const,
    actor_github_user_id: String(actorGitHubUserId),
    comment: null,
    previous_status: 'pending' as const,
    correlation_id: `candidate:test:qa:${changeId}`,
    reason_code: 'qa_status_set',
    qa_reset_epoch: 0,
    created_at: observedAt,
  }
}

async function loadQueuedRequestId(database: DatabaseClient): Promise<string> {
  const request = await database.kysely
    .selectFrom('release_candidate_evaluation_requests')
    .select('id')
    .where('project_id', '=', projectId)
    .where('status', '=', 'queued')
    .executeTakeFirstOrThrow()

  return request.id
}

function execution(requestId: string) {
  return {
    requestId,
    attempt: 1,
    maxAttempts: 10,
    correlationId: `candidate:test:evaluate:${requestId}`,
    causationId: `candidate-test:${requestId}`,
    signal: new AbortController().signal,
    logger,
  }
}

function allowedAccessService(): GitHubRepositoryAccessService {
  return {
    async reconcileUserInstallations() {
      return []
    },
    async authorizeRepositoryAccess(input): Promise<RepositoryAccessDecision> {
      return {
        allowed: true,
        reason: 'allowed',
        githubUserId: input.githubUserId,
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        repositoryPermission: 'maintain',
        requiredPermission: input.requiredPermission,
        verifiedAt: new Date(),
        cacheExpiresAt: new Date(Date.now() + 60_000),
      }
    },
    invalidateAll() {},
    invalidateInstallation() {},
    invalidateUser() {},
  }
}

function asRecord(value: JsonValue | undefined): { readonly [key: string]: JsonValue } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected candidate evaluation summary object')
  }

  return value as Readonly<Record<string, JsonValue>>
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected candidate evaluation array')
  }

  return value
}
