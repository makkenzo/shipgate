import { createDatabase, type DatabaseClient, migrateToLatest } from '@shipgate/database'
import { GITHUB_APP_REPOSITORY_PERMISSIONS } from '@shipgate/github'
import { migrateJobQueue } from '@shipgate/jobs'
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

const actorGitHubUserId = 99
const sourceSha = 'a'.repeat(40)
const productionSha = 'b'.repeat(40)
const successfulHead = 'c'.repeat(40)
const missingHead = 'd'.repeat(40)
const unknownHead = 'e'.repeat(40)

describe.sequential('Repository dashboard read model', () => {
  let postgres: PostgresTestDatabase
  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    database = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: 'shipgate-repository-dashboard-test',
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
    await migrateJobQueue(database)
    await migrateToLatest(database.kysely)
  }, 60_000)

  afterAll(async () => {
    await database.destroy()
    await postgres.stop()
  })

  it('serves one coherent overview, changes table and synchronization history from the committed projection', async () => {
    const fixture = await seedDashboardProjection(database, 1)
    const service = createProjectService({
      database,
      githubRepositoryAccess: createAccessService('allowed'),
      topologyValidator: unusedTopologyValidator(),
    })

    const overview = await service.getOverview(actorGitHubUserId, fixture.projectId)

    expect(overview).toMatchObject({
      project: {
        id: fixture.projectId,
        repositoryId: String(fixture.repositoryId),
        repositoryFullName: 'octocat/shipgate-1',
        sourceSha,
        productionSha,
      },
      branches: {
        source: { name: 'develop', sha: sourceSha, protected: false },
        production: { name: 'main', sha: productionSha, protected: true },
      },
      counts: {
        unreleasedChanges: 1,
        partiallyPresentChanges: 1,
        unknownChanges: 1,
        unmanagedCommits: 1,
        ambiguousCommits: 1,
      },
      requiredChecks: {
        policyVersion: 1,
        state: 'missing',
        checks: [
          expect.objectContaining({
            context: 'ci/test',
            state: 'missing',
            stateCounts: {
              pending: 0,
              successful: 1,
              failed: 0,
              missing: 1,
              stale: 0,
            },
          }),
        ],
      },
      lastSynchronization: {
        id: fixture.syncRunId,
        status: 'succeeded',
        classification: 'recoverable_drift',
        issueCount: 1,
      },
      health: {
        state: 'degraded',
      },
    })
    expect(overview.health.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        'recoverable_drift',
        'unknown_change_identity',
        'ambiguous_commit_attribution',
        'partial_production_presence',
        'unmanaged_commits',
        'required_checks_missing',
      ]),
    )

    const changes = await service.listChanges(actorGitHubUserId, fixture.projectId)

    expect(changes).toHaveLength(3)
    expect(changes.map((change) => [change.pullRequestNumber, change.checkState])).toEqual([
      [101, 'successful'],
      [102, 'missing'],
      [103, 'unknown'],
    ])
    expect(changes[1]).toMatchObject({
      title: 'Partially cherry-picked change',
      mergeMethod: 'rebase',
      productionPresence: 'partially_present',
      commitShas: [missingHead],
    })
    expect(changes[2]).toMatchObject({
      synchronizationState: 'unknown',
      productionPresence: 'unknown',
      commitSetFingerprint: null,
    })

    const synchronization = await service.getSynchronization(
      actorGitHubUserId,
      fixture.projectId,
      10,
    )

    expect(synchronization.runs).toHaveLength(1)
    expect(synchronization.runs[0]).toMatchObject({
      id: fixture.syncRunId,
      status: 'succeeded',
      reason: 'lost_webhook_recovery',
      sourceSha,
      productionSha,
      issueCount: 1,
      issues: [
        expect.objectContaining({
          code: 'missed_webhook_repaired',
          scope: 'repository',
        }),
      ],
    })
    expect(synchronization.runs[0]?.durationMs).toBe(2_000)
  })

  it('coalesces repeated manual reconciliation requests and preserves the latest pending intent', async () => {
    const fixture = await seedDashboardProjection(database, 2, { includeProjectionDetails: false })
    const service = createProjectService({
      database,
      githubRepositoryAccess: createAccessService('allowed'),
      topologyValidator: unusedTopologyValidator(),
    })

    const first = await service.reconcile({
      actorGitHubUserId,
      projectId: fixture.projectId,
      expectedConfigurationVersion: 1,
      correlationId: 'dashboard:manual:first',
    })
    const second = await service.reconcile({
      actorGitHubUserId,
      projectId: fixture.projectId,
      expectedConfigurationVersion: 1,
      correlationId: 'dashboard:manual:second',
    })

    expect(second.id).toBe(first.id)
    const requests = await database.kysely
      .selectFrom('repository_reconciliation_requests')
      .select(['id', 'status', 'reason', 'coalesced_count', 'trigger_scope'])
      .where('project_id', '=', fixture.projectId)
      .execute()
    const runs = await database.kysely
      .selectFrom('repository_sync_runs')
      .select(['id', 'status', 'reason'])
      .where('project_id', '=', fixture.projectId)
      .execute()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      id: first.id,
      status: 'queued',
      reason: 'manual_reconciliation',
      coalesced_count: 1,
    })
    expect(requests[0]?.trigger_scope).toMatchObject({
      reasons: ['manual_reconciliation'],
      branchNames: ['develop', 'main'],
      requireReconciliation: true,
    })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'queued', reason: 'manual_reconciliation' })
  })

  it('keeps the last projection readable while an installation is suspended but rejects mutation', async () => {
    const fixture = await seedDashboardProjection(database, 3, {
      installationState: 'suspended',
      includeProjectionDetails: false,
    })
    const service = createProjectService({
      database,
      githubRepositoryAccess: createAccessService('installation_suspended'),
      topologyValidator: unusedTopologyValidator(),
    })

    await expect(service.getOverview(actorGitHubUserId, fixture.projectId)).resolves.toMatchObject({
      project: { id: fixture.projectId, sourceSha, productionSha },
      health: {
        state: 'disconnected',
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'installation_suspended' }),
        ]),
      },
    })

    await expect(
      service.reconcile({
        actorGitHubUserId,
        projectId: fixture.projectId,
        expectedConfigurationVersion: 1,
        correlationId: 'dashboard:suspended:reconcile',
      }),
    ).rejects.toMatchObject({ code: 'installation_unavailable' })
  })
})

async function seedDashboardProjection(
  database: DatabaseClient,
  index: number,
  options: {
    readonly installationState?: 'active' | 'suspended'
    readonly includeProjectionDetails?: boolean
  } = {},
): Promise<{
  readonly projectId: string
  readonly installationId: number
  readonly repositoryId: number
  readonly syncRunId: string
}> {
  const installationId = 1_000 + index
  const repositoryId = 2_000 + index
  const projectId = `dashboard-project-${index}`
  const syncRunId = `dashboard-sync-run-${index}`
  const now = new Date(`2026-08-05T0${index}:00:00.000Z`)
  const includeProjectionDetails = options.includeProjectionDetails ?? true
  const suspended = options.installationState === 'suspended'

  await database.kysely
    .insertInto('github_users')
    .values({
      github_user_id: String(actorGitHubUserId),
      login: 'octocat',
      avatar_url: null,
      display_name: 'The Octocat',
      email: null,
      html_url: 'https://github.com/octocat',
      installations: '[]',
      installations_synced_at: now,
      updated_at: now,
    })
    .onConflict((conflict) => conflict.column('github_user_id').doNothing())
    .execute()
  await database.kysely
    .insertInto('github_user_credentials')
    .values({
      github_user_id: String(actorGitHubUserId),
      version: 1,
      encrypted_access_token: 'dashboard-access-token',
      access_token_expires_at: new Date('2099-01-01T00:00:00.000Z'),
      encrypted_refresh_token: 'dashboard-refresh-token',
      refresh_token_expires_at: new Date('2099-02-01T00:00:00.000Z'),
      refresh_lease_id: null,
      refresh_lease_expires_at: null,
      updated_at: now,
    })
    .onConflict((conflict) => conflict.column('github_user_id').doNothing())
    .execute()
  await database.kysely
    .insertInto('github_installations')
    .values({
      installation_id: String(installationId),
      owner_id: String(actorGitHubUserId),
      owner_type: 'User',
      owner_login: 'octocat',
      owner_avatar_url: null,
      repository_selection: 'selected',
      suspended_at: suspended ? now : null,
      permission_state: suspended ? 'suspended' : 'current',
      lifecycle_state: suspended ? 'suspended' : 'active',
      deletion_requested_at: null,
      deleted_at: null,
      last_successful_confirmation_at: now,
      last_reconciled_at: now,
      updated_at: now,
    })
    .execute()
  await database.kysely
    .insertInto('github_installation_repositories')
    .values({
      installation_id: String(installationId),
      repository_id: String(repositoryId),
      owner_id: String(actorGitHubUserId),
      owner_login: 'octocat',
      name: `shipgate-${index}`,
      full_name: `octocat/shipgate-${index}`,
      private: true,
      archived: false,
      disabled: false,
      default_branch: 'main',
      visibility: 'private',
      last_successful_confirmation_at: now,
      last_reconciled_at: now,
      updated_at: now,
    })
    .execute()
  await database.kysely
    .insertInto('github_user_installations')
    .values({
      github_user_id: String(actorGitHubUserId),
      installation_id: String(installationId),
      last_reconciled_at: now,
      updated_at: now,
    })
    .execute()
  await database.kysely
    .insertInto('github_user_installation_repositories')
    .values({
      github_user_id: String(actorGitHubUserId),
      installation_id: String(installationId),
      repository_id: String(repositoryId),
      repository_permission: 'maintain',
      last_reconciled_at: now,
      updated_at: now,
    })
    .execute()
  await database.kysely
    .insertInto('github_installation_permissions')
    .values(
      Object.entries(GITHUB_APP_REPOSITORY_PERMISSIONS).map(
        ([permissionName, permissionLevel]) => ({
          installation_id: String(installationId),
          permission_name: permissionName,
          permission_level: permissionLevel,
          last_reconciled_at: now,
          updated_at: now,
        }),
      ),
    )
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
        required_check_policy_version: includeProjectionDetails ? 1 : 0,
        required_check_overrides: '[]',
        deletion_requested_at: null,
        deleted_at: null,
        updated_at: now,
      })
      .execute()

    if (!includeProjectionDetails) {
      return
    }

    await transaction
      .insertInto('repository_branches')
      .values([
        {
          project_id: projectId,
          repository_id: String(repositoryId),
          name: 'develop',
          head_sha: sourceSha,
          protected: false,
          default_branch: false,
          observed_at: now,
          updated_at: now,
        },
        {
          project_id: projectId,
          repository_id: String(repositoryId),
          name: 'main',
          head_sha: productionSha,
          protected: true,
          default_branch: true,
          observed_at: now,
          updated_at: now,
        },
      ])
      .execute()
    await transaction
      .insertInto('repository_commits')
      .values([
        commitRow(projectId, repositoryId, successfulHead, 0, 'managed', now),
        commitRow(projectId, repositoryId, missingHead, 1, 'unmanaged', now),
        commitRow(projectId, repositoryId, unknownHead, 2, 'ambiguous', now),
      ])
      .execute()
    await transaction
      .insertInto('changes')
      .values([
        changeRow(projectId, repositoryId, 101, successfulHead, 'unreleased', 'known', now),
        {
          ...changeRow(
            projectId,
            repositoryId,
            102,
            missingHead,
            'partially_present',
            'known',
            now,
          ),
          title: 'Partially cherry-picked change',
          merge_method: 'rebase',
        },
        {
          ...changeRow(projectId, repositoryId, 103, unknownHead, 'unknown', 'unknown', now),
          commit_set_fingerprint: null,
        },
      ])
      .execute()
    await transaction
      .insertInto('change_commits')
      .values([
        changeCommitRow(projectId, repositoryId, 101, successfulHead),
        changeCommitRow(projectId, repositoryId, 102, missingHead),
        changeCommitRow(projectId, repositoryId, 103, unknownHead),
      ])
      .execute()
    const requiredCheckId = `dashboard-required-check-${index}`
    await transaction
      .insertInto('required_checks')
      .values({
        id: requiredCheckId,
        project_id: projectId,
        repository_id: String(repositoryId),
        policy_version: 1,
        context: 'ci/test',
        integration_id: '9001',
        source: 'branch_protection',
        source_reference: 'develop',
        observed_at: now,
        updated_at: now,
      })
      .execute()
    await transaction
      .insertInto('change_required_check_states')
      .values([
        {
          project_id: projectId,
          repository_id: String(repositoryId),
          change_id: changeId(index, 101),
          required_check_id: requiredCheckId,
          policy_version: 1,
          commit_sha: successfulHead,
          state: 'successful',
          evidence_ids: '[]',
          observed_at: now,
          updated_at: now,
        },
        {
          project_id: projectId,
          repository_id: String(repositoryId),
          change_id: changeId(index, 102),
          required_check_id: requiredCheckId,
          policy_version: 1,
          commit_sha: missingHead,
          state: 'missing',
          evidence_ids: '[]',
          observed_at: now,
          updated_at: now,
        },
      ])
      .execute()
    await transaction
      .insertInto('repository_sync_runs')
      .values({
        id: syncRunId,
        project_id: projectId,
        repository_id: String(repositoryId),
        reason: 'lost_webhook_recovery',
        status: 'succeeded',
        configuration_version: 1,
        idempotency_key: `dashboard-sync-${index}`,
        projection_fingerprint: 'f'.repeat(64),
        source_sha: sourceSha,
        production_sha: productionSha,
        started_at: now,
        completed_at: new Date(now.getTime() + 2_000),
        error_code: null,
        error_message: null,
        reconciliation_classification: 'recoverable_drift',
        difference_summary: JSON.stringify({ repaired: true }),
      })
      .execute()
    await transaction
      .insertInto('repository_sync_issues')
      .values({
        id: `dashboard-sync-issue-${index}`,
        sync_run_id: syncRunId,
        project_id: projectId,
        repository_id: String(repositoryId),
        severity: 'warning',
        code: 'missed_webhook_repaired',
        scope: 'repository',
        subject_id: String(repositoryId),
        message: 'A missed webhook was repaired by reconciliation.',
        details: JSON.stringify({ repaired: true }),
      })
      .execute()
  })

  return { projectId, installationId, repositoryId, syncRunId }
}

function commitRow(
  projectId: string,
  repositoryId: number,
  sha: string,
  sourceDeltaPosition: number,
  attributionState: 'managed' | 'unmanaged' | 'ambiguous',
  observedAt: Date,
) {
  return {
    project_id: projectId,
    repository_id: String(repositoryId),
    sha,
    tree_sha: '1'.repeat(40),
    message: `commit-${sourceDeltaPosition}`,
    author_id: String(actorGitHubUserId),
    author_login: 'octocat',
    author_name: 'The Octocat',
    author_email: 'octocat@example.test',
    committer_id: String(actorGitHubUserId),
    committer_login: 'octocat',
    authored_at: observedAt,
    committed_at: observedAt,
    parent_shas: JSON.stringify([sourceDeltaPosition === 0 ? productionSha : successfulHead]),
    source_delta_position: sourceDeltaPosition,
    first_parent_position: sourceDeltaPosition,
    integration_point_sha: sha,
    production_patch_equivalent: sourceDeltaPosition === 1,
    attribution_state: attributionState,
    observed_at: observedAt,
    updated_at: observedAt,
  }
}

function changeRow(
  projectId: string,
  repositoryId: number,
  pullRequestNumber: number,
  finalHeadSha: string,
  productionPresence: 'unreleased' | 'partially_present' | 'unknown',
  synchronizationState: 'known' | 'unknown',
  observedAt: Date,
) {
  const index = Number(projectId.split('-').at(-1))

  return {
    id: changeId(index, pullRequestNumber),
    project_id: projectId,
    repository_id: String(repositoryId),
    github_pull_request_id: String(10_000 + pullRequestNumber),
    pull_request_number: pullRequestNumber,
    title: `Pull request ${pullRequestNumber}`,
    url: `https://github.com/octocat/shipgate/pull/${pullRequestNumber}`,
    author_id: String(actorGitHubUserId),
    author_login: 'octocat',
    base_branch: 'develop',
    merged_at: observedAt,
    final_head_sha: finalHeadSha,
    merge_commit_sha: finalHeadSha,
    source_integration_sha: finalHeadSha,
    integration_first_parent_sha: productionSha,
    integration_second_parent_sha: null,
    merge_method: 'squash' as const,
    commit_set_fingerprint: '9'.repeat(64),
    synchronization_state: synchronizationState,
    production_presence: productionPresence,
    observed_at: observedAt,
    updated_at: observedAt,
  }
}

function changeCommitRow(
  projectId: string,
  repositoryId: number,
  pullRequestNumber: number,
  commitSha: string,
) {
  const index = Number(projectId.split('-').at(-1))

  return {
    project_id: projectId,
    repository_id: String(repositoryId),
    change_id: changeId(index, pullRequestNumber),
    commit_sha: commitSha,
    position: 0,
  }
}

function changeId(index: number, pullRequestNumber: number): string {
  return `dashboard-change-${index}-${pullRequestNumber}`
}

function createAccessService(
  reason: 'allowed' | 'installation_suspended',
): GitHubRepositoryAccessService {
  return {
    async reconcileUserInstallations() {
      return []
    },
    async authorizeRepositoryAccess(input): Promise<RepositoryAccessDecision> {
      return {
        allowed: reason === 'allowed',
        reason,
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

function unusedTopologyValidator(): ProjectTopologyValidator {
  return {
    async validate() {
      throw new Error('Topology validation is not used by repository dashboard tests')
    },
  }
}
