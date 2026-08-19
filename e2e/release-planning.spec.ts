import { expect, type Page, type Route, test } from '@playwright/test'

const projectId = 'release-planning-e2e'
const sourceSha = 'a'.repeat(40)
const productionSha = 'b'.repeat(40)
const dependentId = 'change-checkout'
const prerequisiteId = 'change-payments'

test('moves a merged change from QA pending through a deterministic candidate and exclusion', async ({
  page,
}) => {
  const calls: string[] = []
  const api = await mockReleasePlanningApi(page, calls)

  await page.goto(`/projects/${projectId}/changes`)

  await expect(page.getByRole('columnheader', { name: 'QA' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Dependencies' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Candidate state' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Blockers' })).toBeVisible()

  let checkoutRow = page.getByRole('row').filter({ hasText: '#492' }).first()
  await expect(checkoutRow.getByText('QA has not passed', { exact: true })).toBeVisible()
  await expect(checkoutRow.getByText('Pending', { exact: true })).toHaveCount(2)

  await checkoutRow.getByRole('button', { name: 'QA Passed' }).click()
  await expect.poll(() => calls.filter((call) => call === 'qa:passed').length).toBe(1)
  checkoutRow = page.getByRole('row').filter({ hasText: '#492' }).first()
  await expect(checkoutRow.getByText('Passed', { exact: true })).toBeVisible()
  await expect(checkoutRow.getByText('Blocked', { exact: true })).toBeVisible()
  await expect(checkoutRow.getByText('ci is pending', { exact: true })).toBeVisible()

  api.markChecksSuccessful()
  await page.reload()
  checkoutRow = page.getByRole('row').filter({ hasText: '#492' }).first()
  await expect(checkoutRow.getByText('Passing', { exact: true })).toBeVisible()
  await expect(checkoutRow.getByText('Ready', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'Release' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/release$`))
  await expect(page.getByText('Release ready', { exact: true })).toBeVisible()
  await expect(page.getByText('READY', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Build release/i })).toHaveCount(0)

  await page.getByRole('link', { name: 'Changes' }).click()
  checkoutRow = page.getByRole('row').filter({ hasText: '#492' }).first()
  await checkoutRow.getByRole('button', { name: 'Edit dependencies' }).click()
  await page.getByLabel(/#481 Payment retries/).check()
  await page.getByRole('button', { name: 'Save dependencies' }).click()
  await expect.poll(() => calls.filter((call) => call === 'dependencies:481').length).toBe(1)
  checkoutRow = page.getByRole('row').filter({ hasText: '#492' }).first()
  await expect(checkoutRow.getByText('#481', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'Release' }).click()
  const includedCard = page
    .getByText('Included', { exact: true })
    .locator('xpath=ancestor::*[@data-slot="card"]')
  const includedItems = includedCard.locator('ol > li')
  await expect(includedItems).toHaveCount(2)
  await expect(includedItems.nth(0)).toContainText('#481 Payment retries')
  await expect(includedItems.nth(1)).toContainText('#492 New checkout')
  await expect(page.getByText('READY', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'Changes' }).click()
  const paymentRow = page.getByRole('row').filter({ hasText: '#481' }).first()
  await paymentRow.getByRole('button', { name: 'Exclude' }).click()
  await page.getByLabel('Exclusion reason for PR #481').fill('Ship payment retries separately')
  await page.getByRole('button', { name: 'Confirm exclusion' }).click()
  await expect.poll(() => calls.filter((call) => call === 'exclude:481').length).toBe(1)
  await expect(paymentRow.getByText('Excluded', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'Release' }).click()
  await expect(page.getByText('BLOCKED', { exact: true })).toBeVisible()
  await expect(page.getByText('Ship payment retries separately', { exact: true })).toBeVisible()
  await expect(page.getByText('GitHub user #99', { exact: true })).toBeVisible()
  await expect(page.getByText('#492 New checkout', { exact: true })).toBeVisible()
  await expect(page.getByText('Depends on excluded PR #481', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'Changes' }).click()
  await page
    .getByRole('row')
    .filter({ hasText: '#481' })
    .first()
    .getByRole('button', { name: 'Restore' })
    .click()
  await expect.poll(() => calls.filter((call) => call === 'restore:481').length).toBe(1)

  await page.getByRole('link', { name: 'Release' }).click()
  await expect(page.getByText('READY', { exact: true })).toBeVisible()
  await expect(page.getByText('No changes are excluded.', { exact: true })).toBeVisible()
})

async function mockReleasePlanningApi(
  page: Page,
  calls: string[],
): Promise<{ readonly markChecksSuccessful: () => void }> {
  let qaStatus: 'pending' | 'passed' | 'failed' = 'pending'
  let checkState: 'pending' | 'successful' = 'pending'
  let dependencyChangeIds: string[] = []
  let exclusionReason: string | null = null
  let candidateVersion = 1
  let evaluationVersion = 1

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (path === '/api/v1/auth/session') {
      await json(route, {
        authenticated: true,
        session: { id: 'release-ui-session', expiresAt: '2026-08-19T00:00:00.000Z' },
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

    if (path === `/api/v1/projects/${projectId}/overview` && method === 'GET') {
      await json(route, overviewFixture(checkState))
      return
    }

    if (path === `/api/v1/projects/${projectId}/changes` && method === 'GET') {
      await json(route, { changes: changesFixture(qaStatus, checkState) })
      return
    }

    if (path === `/api/v1/projects/${projectId}/release-candidate` && method === 'GET') {
      await json(route, {
        candidate: candidateFixture({
          qaStatus,
          checkState,
          dependencyChangeIds,
          exclusionReason,
          candidateVersion,
          evaluationVersion,
        }),
      })
      return
    }

    const dependencyMatch = new RegExp(
      `^/api/v1/projects/${projectId}/changes/([^/]+)/dependencies$`,
    ).exec(path)

    if (dependencyMatch && method === 'GET') {
      await json(route, {
        dependencies:
          dependencyMatch[1] === dependentId && dependencyChangeIds.includes(prerequisiteId)
            ? [dependencyFixture()]
            : [],
      })
      return
    }

    if (dependencyMatch && method === 'PUT') {
      const body = request.postDataJSON() as { readonly dependencyChangeIds?: readonly string[] }
      dependencyChangeIds = [...(body.dependencyChangeIds ?? [])]
      candidateVersion += 1
      evaluationVersion += 1
      calls.push(`dependencies:${dependencyChangeIds.includes(prerequisiteId) ? '481' : 'none'}`)
      await json(route, {
        status: 'recorded',
        dependentChangeId: dependentId,
        dependentPullRequestNumber: 492,
        dependencies: dependencyChangeIds.includes(prerequisiteId) ? [dependencyFixture()] : [],
        candidateReevaluation: {
          candidateId: 'candidate-release-ui',
          candidateVersion,
        },
        githubBodyUpdated: true,
      })
      return
    }

    const qaMatch = new RegExp(`^/api/v1/projects/${projectId}/changes/([^/]+)/qa$`).exec(path)

    if (qaMatch && method === 'PUT') {
      const body = request.postDataJSON() as {
        readonly status: 'pending' | 'passed' | 'failed'
      }
      qaStatus = body.status
      candidateVersion += 1
      evaluationVersion += 1
      calls.push(`qa:${qaStatus}`)
      await json(route, {
        status: 'recorded',
        qa: qaState(qaStatus),
        candidateReevaluation: {
          candidateId: 'candidate-release-ui',
          candidateVersion,
        },
      })
      return
    }

    const exclusionMatch = new RegExp(
      `^/api/v1/projects/${projectId}/changes/([^/]+)/exclusion$`,
    ).exec(path)

    if (exclusionMatch && method === 'PUT') {
      const body = request.postDataJSON() as { readonly reason?: string }
      exclusionReason = body.reason?.trim() || null
      candidateVersion += 1
      evaluationVersion += 1
      calls.push('exclude:481')
      await json(route, {
        status: 'recorded',
        candidateId: 'candidate-release-ui',
        candidateVersion,
        changeId: exclusionMatch[1],
        excluded: true,
        evaluationRequestId: `evaluation-request-${evaluationVersion}`,
      })
      return
    }

    if (exclusionMatch && method === 'DELETE') {
      exclusionReason = null
      candidateVersion += 1
      evaluationVersion += 1
      calls.push('restore:481')
      await json(route, {
        status: 'recorded',
        candidateId: 'candidate-release-ui',
        candidateVersion,
        changeId: exclusionMatch[1],
        excluded: false,
        evaluationRequestId: `evaluation-request-${evaluationVersion}`,
      })
      return
    }

    await json(
      route,
      {
        code: 'UNEXPECTED_TEST_REQUEST',
        message: `${method} ${path} was not mocked`,
        requestId: 'release-planning-e2e',
      },
      500,
    )
  })

  return {
    markChecksSuccessful() {
      checkState = 'successful'
      evaluationVersion += 1
      calls.push('checks:successful')
    },
  }
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
    sourceBranch: 'master',
    productionBranch: 'prod',
    status: 'active',
    sourceSha,
    productionSha,
    lastSuccessfulSynchronization: '2026-08-18T09:10:00.000Z',
    configurationVersion: 3,
    requiredCheckPolicyVersion: 2,
    requiredCheckOverrides: [],
    deletionRequestedAt: null,
    createdAt: '2026-08-18T08:00:00.000Z',
    updatedAt: '2026-08-18T09:10:00.000Z',
  }
}

function overviewFixture(checkState: 'pending' | 'successful') {
  return {
    project: projectFixture(),
    branches: {
      source: {
        name: 'master',
        sha: sourceSha,
        protected: true,
        defaultBranch: true,
        observedAt: '2026-08-18T09:10:00.000Z',
      },
      production: {
        name: 'prod',
        sha: productionSha,
        protected: true,
        defaultBranch: false,
        observedAt: '2026-08-18T09:10:00.000Z',
      },
    },
    counts: {
      unreleasedChanges: 2,
      partiallyPresentChanges: 0,
      unknownChanges: 0,
      unmanagedCommits: 0,
      ambiguousCommits: 0,
    },
    requiredChecks: { policyVersion: 2, state: checkState, checks: [] },
    lastSynchronization: null,
    health: {
      state: 'healthy',
      summary: 'Projection is current and internally consistent.',
      reasons: [],
    },
  }
}

function changesFixture(
  qaStatus: 'pending' | 'passed' | 'failed',
  checkState: 'pending' | 'successful',
) {
  return [
    changeFixture({
      id: prerequisiteId,
      pullRequestNumber: 481,
      title: 'Payment retries',
      mergedAt: '2026-08-18T08:30:00.000Z',
      qaStatus: 'passed',
      checkState: 'successful',
      sha: 'c'.repeat(40),
    }),
    changeFixture({
      id: dependentId,
      pullRequestNumber: 492,
      title: 'New checkout',
      mergedAt: '2026-08-18T09:00:00.000Z',
      qaStatus,
      checkState,
      sha: 'd'.repeat(40),
    }),
  ]
}

function changeFixture(input: {
  readonly id: string
  readonly pullRequestNumber: number
  readonly title: string
  readonly mergedAt: string
  readonly qaStatus: 'pending' | 'passed' | 'failed'
  readonly checkState: 'pending' | 'successful'
  readonly sha: string
}) {
  return {
    id: input.id,
    githubPullRequestId: input.pullRequestNumber + 10_000,
    pullRequestNumber: input.pullRequestNumber,
    title: input.title,
    url: `https://github.com/octocat/shipgate/pull/${input.pullRequestNumber}`,
    authorId: 99,
    authorLogin: 'octocat',
    mergedAt: input.mergedAt,
    mergeMethod: 'squash',
    commitCount: 1,
    commitSetFingerprint: input.sha,
    synchronizationState: 'known',
    productionPresence: 'unreleased',
    checkState: input.checkState,
    qa: qaState(input.qaStatus),
    finalHeadSha: input.sha,
    commitShas: [input.sha],
    requiredChecks: [
      {
        requiredCheckId: `ci-${input.id}`,
        policyVersion: 2,
        context: 'ci',
        integrationId: 42,
        source: 'branch_protection',
        sourceReference: 'master',
        commitSha: input.sha,
        state: input.checkState,
        observations: [],
        observedAt: '2026-08-18T09:10:00.000Z',
      },
    ],
  }
}

function qaState(status: 'pending' | 'passed' | 'failed') {
  return {
    status,
    assessmentId: status === 'pending' ? null : `qa-${status}`,
    comment: null,
    actorGitHubUserId: status === 'pending' ? null : 99,
    assessedAt: status === 'pending' ? null : '2026-08-18T09:11:00.000Z',
  }
}

function dependencyFixture() {
  return {
    changeId: prerequisiteId,
    pullRequestNumber: 481,
    source: 'user',
    actorGitHubUserId: 99,
    version: 1,
    updatedAt: '2026-08-18T09:12:00.000Z',
  }
}

function candidateFixture(input: {
  readonly qaStatus: 'pending' | 'passed' | 'failed'
  readonly checkState: 'pending' | 'successful'
  readonly dependencyChangeIds: readonly string[]
  readonly exclusionReason: string | null
  readonly candidateVersion: number
  readonly evaluationVersion: number
}) {
  const qaBlocker =
    input.qaStatus === 'pending'
      ? releaseBlocker('qa_pending', dependentId)
      : input.qaStatus === 'failed'
        ? releaseBlocker('qa_failed', dependentId)
        : null
  const checkBlocker =
    input.checkState === 'pending'
      ? releaseBlocker('required_check_pending', dependentId, null, 'ci')
      : null
  const paymentExcluded = input.exclusionReason !== null
  const dependencyBlocker =
    paymentExcluded && input.dependencyChangeIds.includes(prerequisiteId)
      ? releaseBlocker('dependency_excluded', dependentId, prerequisiteId)
      : null
  const checkoutBlockers = [qaBlocker, checkBlocker, dependencyBlocker].filter(
    (blocker): blocker is ReturnType<typeof releaseBlocker> => blocker !== null,
  )
  const paymentChange = evaluatedChange(
    prerequisiteId,
    481,
    '2026-08-18T08:30:00.000Z',
    paymentExcluded ? 'excluded' : 'ready',
    [],
  )
  const checkoutChange = evaluatedChange(
    dependentId,
    492,
    '2026-08-18T09:00:00.000Z',
    checkoutBlockers.length === 0 ? 'ready' : 'blocked',
    checkoutBlockers,
  )
  const includedChanges = paymentExcluded ? [checkoutChange] : [paymentChange, checkoutChange]
  const blockers = includedChanges.flatMap((change) => change.blockers)
  const result = blockers.length === 0 ? 'ready' : 'blocked'
  const summary = {
    status: result,
    includedChanges,
    excludedChanges: paymentExcluded ? [paymentChange] : [],
    orderedChanges: includedChanges.map((change) => change.changeId),
    blockers,
    evaluatedAgainst: {
      sourceSha,
      productionSha,
      configurationVersion: 3,
      projectionVersion: input.evaluationVersion,
    },
  }

  return {
    id: 'candidate-release-ui',
    sequence: 1,
    version: input.candidateVersion,
    status: result,
    createdByGitHubUserId: null,
    latestEvaluationVersion: input.evaluationVersion,
    latestEvaluation: {
      id: `evaluation-${input.evaluationVersion}`,
      version: input.evaluationVersion,
      result,
      summary,
      blockers,
      evaluatedAt: '2026-08-18T09:15:00.000Z',
      projectStateVersion: input.evaluationVersion,
      projectionVersion: input.evaluationVersion,
    },
    pendingEvaluation: null,
    exclusions: paymentExcluded
      ? [
          {
            changeId: prerequisiteId,
            pullRequestNumber: 481,
            title: 'Payment retries',
            actorGitHubUserId: 99,
            reason: input.exclusionReason,
            candidateVersion: input.candidateVersion,
            excludedAt: '2026-08-18T09:14:00.000Z',
            updatedAt: '2026-08-18T09:14:00.000Z',
          },
        ]
      : [],
    createdAt: '2026-08-18T09:10:00.000Z',
    updatedAt: '2026-08-18T09:15:00.000Z',
  }
}

function releaseBlocker(
  code: 'qa_pending' | 'qa_failed' | 'required_check_pending' | 'dependency_excluded',
  changeId: string,
  dependencyChangeId: string | null = null,
  checkName: string | null = null,
) {
  return { code, changeId, dependencyChangeId, checkName, commitSha: null }
}

function evaluatedChange(
  changeId: string,
  pullRequestNumber: number,
  mergedAt: string,
  status: 'ready' | 'blocked' | 'excluded',
  blockers: readonly ReturnType<typeof releaseBlocker>[],
) {
  return { changeId, pullRequestNumber, mergedAt, status, blockers }
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}
