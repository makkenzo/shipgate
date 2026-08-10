import { expect, type Page, type Route, test } from '@playwright/test'

const projectId = 'project-dashboard-e2e'
const sourceSha = 'a'.repeat(40)
const productionSha = 'b'.repeat(40)

test('covers the repository dashboard routes and manual reconciliation', async ({ page }) => {
  const calls: string[] = []
  await mockProjectApi(page, calls)

  await page.goto('/projects')
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
  await expect(page.getByText('octocat/shipgate')).toBeVisible()
  await page.getByRole('link', { name: 'Open' }).click()

  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`))
  await expect(page.getByRole('heading', { name: 'octocat/shipgate' })).toBeVisible()
  await expect(page.getByText('Unreleased changes')).toBeVisible()
  await expect(page.getByText('Project health')).toBeVisible()
  await expect(page.getByText('Required checks', { exact: true }).first()).toBeVisible()

  await page.getByRole('link', { name: 'Changes' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/changes$`))
  await expect(page.getByRole('columnheader', { name: 'PR' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Production presence' })).toBeVisible()
  await expect(page.getByText('Ship dashboard')).toBeVisible()
  await expect(page.getByText('Partially present')).toBeVisible()

  await page.getByRole('link', { name: 'Synchronization' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/synchronization$`))
  await expect(page.getByText('Lost Webhook Recovery')).toBeVisible()
  await expect(page.getByText('A missed webhook was repaired by reconciliation.')).toBeVisible()
  await page.getByRole('button', { name: 'Reconcile now' }).click()
  await expect
    .poll(() => calls.filter((call) => call === 'POST /api/v1/projects/reconciliation').length)
    .toBe(1)
  await expect(page.getByText(/Reconciliation request manual-request is queued/)).toBeVisible()

  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/settings$`))
  await expect(page.getByLabel('Source branch')).toHaveValue('develop')
  await expect(page.getByLabel('Production branch')).toHaveValue('main')
  await expect(page.getByLabel('Required-check overrides')).toHaveValue('shipgate/manual')

  await page.goto('/projects/new')
  await expect(page.getByRole('heading', { name: 'New project' })).toBeVisible()
  await page.getByLabel('GitHub installation').selectOption('123')
  await page.getByLabel('Repository').selectOption('456')
  await expect(page.getByLabel('Production branch')).toHaveValue('main')
  await expect(page.getByRole('button', { name: 'Create project' })).toBeEnabled()
})

async function mockProjectApi(page: Page, calls: string[]): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (path === '/api/v1/auth/session') {
      await json(route, {
        authenticated: true,
        session: { id: 'project-ui-session', expiresAt: '2026-08-06T00:00:00.000Z' },
        user: {
          id: 99,
          login: 'octocat',
          avatarUrl: null,
          displayName: 'The Octocat',
          email: null,
          htmlUrl: 'https://github.com/octocat',
          installations: [],
        },
      })
      return
    }

    if (path === '/api/v1/projects' && method === 'GET') {
      await json(route, { projects: [projectFixture()] })
      return
    }

    if (path === `/api/v1/projects/${projectId}/overview` && method === 'GET') {
      await json(route, overviewFixture())
      return
    }

    if (path === `/api/v1/projects/${projectId}/changes` && method === 'GET') {
      await json(route, { changes: [changeFixture()] })
      return
    }

    if (path === `/api/v1/projects/${projectId}/synchronization` && method === 'GET') {
      await json(route, synchronizationFixture())
      return
    }

    if (path === `/api/v1/projects/${projectId}/reconciliation` && method === 'POST') {
      calls.push('POST /api/v1/projects/reconciliation')
      await json(
        route,
        {
          reconciliation: {
            requestId: 'manual-request',
            status: 'queued',
            configurationVersion: 3,
            reason: 'manual_reconciliation',
            mode: 'full',
            sourceSha,
            productionSha,
            requestedAt: '2026-08-05T10:05:00.000Z',
          },
        },
        202,
      )
      return
    }

    if (path === '/api/v1/installations' && method === 'GET') {
      await json(route, {
        installations: [
          {
            id: 123,
            owner: { id: 99, login: 'octocat', type: 'User', avatarUrl: null },
            repositorySelection: 'selected',
            lifecycleState: 'active',
            permissionState: 'current',
            suspendedAt: null,
            repositoryCount: 1,
            userRepositoryCount: 1,
            permissions: [],
            permissionUpgradePending: false,
            lastReconciledAt: '2026-08-05T10:00:00.000Z',
          },
        ],
      })
      return
    }

    if (path === '/api/v1/installations/123' && method === 'GET') {
      await json(route, {
        id: 123,
        owner: { id: 99, login: 'octocat', type: 'User', avatarUrl: null },
        repositorySelection: 'selected',
        lifecycleState: 'active',
        permissionState: 'current',
        suspendedAt: null,
        repositoryCount: 1,
        userRepositoryCount: 1,
        permissions: [],
        permissionUpgradePending: false,
        lastReconciledAt: '2026-08-05T10:00:00.000Z',
        manageUrl: 'https://github.com/settings/installations/123',
        repositories: [
          {
            id: 456,
            ownerId: 99,
            ownerLogin: 'octocat',
            name: 'shipgate',
            fullName: 'octocat/shipgate',
            private: true,
            archived: false,
            disabled: false,
            defaultBranch: 'main',
            visibility: 'private',
            userPermission: 'maintain',
            accessibleToUser: true,
            lastReconciledAt: '2026-08-05T10:00:00.000Z',
          },
        ],
      })
      return
    }

    await json(
      route,
      {
        code: 'UNEXPECTED_TEST_REQUEST',
        message: `${method} ${path} was not mocked`,
        requestId: 'projects-dashboard-e2e',
      },
      500,
    )
  })
}

function projectFixture() {
  return {
    id: projectId,
    installationId: 123,
    repositoryId: 456,
    repository: {
      ownerId: 99,
      ownerLogin: 'octocat',
      name: 'shipgate',
      fullName: 'octocat/shipgate',
      defaultBranch: 'main',
    },
    sourceBranch: 'develop',
    productionBranch: 'main',
    status: 'active',
    sourceSha,
    productionSha,
    lastSuccessfulSynchronization: '2026-08-05T10:00:02.000Z',
    configurationVersion: 3,
    requiredCheckPolicyVersion: 2,
    requiredCheckOverrides: [{ context: 'shipgate/manual', integrationId: null }],
    deletionRequestedAt: null,
    createdAt: '2026-08-05T09:00:00.000Z',
    updatedAt: '2026-08-05T10:00:02.000Z',
  }
}

function overviewFixture() {
  return {
    project: projectFixture(),
    branches: {
      source: {
        name: 'develop',
        sha: sourceSha,
        protected: false,
        defaultBranch: false,
        observedAt: '2026-08-05T10:00:00.000Z',
      },
      production: {
        name: 'main',
        sha: productionSha,
        protected: true,
        defaultBranch: true,
        observedAt: '2026-08-05T10:00:00.000Z',
      },
    },
    counts: {
      unreleasedChanges: 1,
      partiallyPresentChanges: 1,
      unknownChanges: 0,
      unmanagedCommits: 1,
      ambiguousCommits: 0,
    },
    requiredChecks: {
      policyVersion: 2,
      state: 'successful',
      checks: [
        {
          id: 'check-ci',
          context: 'ci/test',
          integrationId: 9001,
          source: 'branch_protection',
          sourceReference: 'develop',
          state: 'successful',
          stateCounts: { pending: 0, successful: 2, failed: 0, missing: 0, stale: 0 },
        },
      ],
    },
    lastSynchronization: synchronizationFixture().runs[0],
    health: {
      state: 'attention',
      summary: 'Projection is usable, but one or more release signals need attention.',
      reasons: [
        {
          severity: 'warning',
          code: 'unmanaged_commits',
          message: '1 direct commit cannot be attributed to a merged pull request.',
        },
      ],
    },
  }
}

function changeFixture() {
  return {
    id: 'change-42',
    githubPullRequestId: 7001,
    pullRequestNumber: 42,
    title: 'Ship dashboard',
    url: 'https://github.com/octocat/shipgate/pull/42',
    authorId: 99,
    authorLogin: 'octocat',
    mergedAt: '2026-08-05T09:45:00.000Z',
    mergeMethod: 'squash',
    commitCount: 1,
    commitSetFingerprint: 'f'.repeat(64),
    synchronizationState: 'known',
    productionPresence: 'partially_present',
    checkState: 'successful',
    finalHeadSha: sourceSha,
    commitShas: [sourceSha],
    requiredChecks: [],
  }
}

function synchronizationFixture() {
  return {
    project: projectFixture(),
    health: {
      state: 'attention',
      summary: 'Projection is usable, but one or more release signals need attention.',
      reasons: [],
    },
    runs: [
      {
        id: 'sync-run-1',
        status: 'succeeded',
        reason: 'lost_webhook_recovery',
        configurationVersion: 3,
        classification: 'recoverable_drift',
        sourceSha,
        productionSha,
        startedAt: '2026-08-05T10:00:00.000Z',
        completedAt: '2026-08-05T10:00:02.000Z',
        durationMs: 2_000,
        errorCode: null,
        errorMessage: null,
        differenceSummary: { repaired: true },
        issueCount: 1,
        requestedAt: '2026-08-05T09:59:59.000Z',
        coalescedCount: 0,
        forcePush: false,
        triggerScope: { reasons: ['lost_webhook_recovery'] },
        issues: [
          {
            id: 'issue-1',
            severity: 'warning',
            code: 'missed_webhook_repaired',
            scope: 'repository',
            subjectId: '456',
            message: 'A missed webhook was repaired by reconciliation.',
            details: { repaired: true },
            createdAt: '2026-08-05T10:00:02.000Z',
          },
        ],
      },
    ],
  }
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}
