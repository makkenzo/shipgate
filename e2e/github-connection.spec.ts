import { expect, type Page, test } from '@playwright/test'

const installationId = 123

interface UiState {
  installations: readonly InstallationFixture[]
}

interface InstallationFixture {
  readonly id: number
  readonly owner: {
    readonly id: number
    readonly login: string
    readonly type: string
    readonly avatarUrl: string | null
  }
  readonly repositorySelection: 'all' | 'selected'
  readonly lifecycleState: 'active' | 'suspended' | 'pending_deletion' | 'deleted'
  readonly permissionState: 'current' | 'stale' | 'suspended' | 'revoked'
  readonly suspendedAt: string | null
  readonly repositoryCount: number
  readonly userRepositoryCount: number
  readonly permissions: readonly {
    readonly name: string
    readonly required: 'read' | 'write'
    readonly actual: 'read' | 'write' | null
    readonly satisfied: boolean
  }[]
  readonly permissionUpgradePending: boolean
  readonly lastReconciledAt: string
  readonly repositories?: readonly {
    readonly id: number
    readonly ownerId: number
    readonly ownerLogin: string
    readonly name: string
    readonly fullName: string
    readonly private: boolean
    readonly archived: boolean
    readonly disabled: boolean
    readonly defaultBranch: string | null
    readonly visibility: string | null
    readonly userPermission: 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin'
    readonly accessibleToUser: boolean
    readonly lastReconciledAt: string
  }[]
}

test('covers the GitHub connection screens', async ({ page }) => {
  const state: UiState = { installations: [] }
  await mockConnectionApi(page, state)

  await page.goto('/setup')
  await expect(page.getByRole('heading', { name: 'Install the Shipgate GitHub App' })).toBeVisible()
  await expect(page.getByText('No installation found')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Install GitHub App' })).toHaveAttribute(
    'href',
    'https://github.com/apps/shipgate-release/installations/new',
  )

  state.installations = [createInstallationFixture({ permissionUpgradePending: true })]
  await page.reload()
  await expect(page.getByText('GitHub App connected')).toBeVisible()
  await page.getByRole('link', { name: 'View installations' }).click()

  await expect(page).toHaveURL(/\/installations$/)
  await expect(page.getByText('octocat')).toBeVisible()
  await expect(page.getByText('Permission upgrade')).toBeVisible()
  await page.getByRole('link', { name: /octocat/ }).click()

  await expect(page).toHaveURL(new RegExp(`/installations/${installationId}$`))
  await expect(page.getByText('Permission upgrade pending')).toBeVisible()
  await expect(page.getByText('No user access')).toBeVisible()
  await expect(page.getByText('read / write')).toBeVisible()

  state.installations = [createInstallationFixture({ permissionUpgradePending: false })]
  await page.reload()
  await expect(page.getByText('Permission upgrade pending')).toHaveCount(0)
  await expect(page.getByText('write', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'Account' }).click()
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Disconnect GitHub' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete local account' })).toBeVisible()
})

async function mockConnectionApi(page: Page, state: UiState): Promise<void> {
  await page.route('**/api/v1/auth/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        session: {
          id: 'ui-session',
          expiresAt: '2026-08-03T21:00:00.000Z',
        },
        user: {
          id: 99,
          login: 'octocat',
          avatarUrl: null,
          displayName: 'The Octocat',
          email: null,
          htmlUrl: 'https://github.com/octocat',
          installations: [],
        },
      }),
    })
  })

  await page.route('**/api/v1/connection', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        githubLoginConfigured: true,
        githubInstallationConfigured: true,
        loginUrl: '/api/v1/auth/github?returnTo=%2Fsetup',
        installUrl: 'https://github.com/apps/shipgate-release/installations/new',
      }),
    })
  })

  await page.route('**/api/v1/installations', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ installations: state.installations }),
    })
  })

  await page.route(`**/api/v1/installations/${installationId}`, async (route) => {
    const installation = state.installations.find((candidate) => candidate.id === installationId)

    await route.fulfill({
      status: installation ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(
        installation
          ? {
              ...installation,
              repositories: installation.repositories ?? [],
              manageUrl: `https://github.com/settings/installations/${installationId}`,
            }
          : {
              code: 'GITHUB_INSTALLATION_NOT_FOUND',
              message: 'GitHub installation was not found for the current user',
              requestId: 'ui-test',
            },
      ),
    })
  })
}

function createInstallationFixture(input: {
  readonly permissionUpgradePending: boolean
}): InstallationFixture {
  const accepted = !input.permissionUpgradePending

  return {
    id: installationId,
    owner: {
      id: 99,
      login: 'octocat',
      type: 'User',
      avatarUrl: null,
    },
    repositorySelection: 'selected',
    lifecycleState: 'active',
    permissionState: 'current',
    suspendedAt: null,
    repositoryCount: 1,
    userRepositoryCount: accepted ? 1 : 0,
    permissions: [
      {
        name: 'metadata',
        required: 'read',
        actual: 'read',
        satisfied: true,
      },
      {
        name: 'contents',
        required: 'write',
        actual: accepted ? 'write' : 'read',
        satisfied: accepted,
      },
    ],
    permissionUpgradePending: input.permissionUpgradePending,
    lastReconciledAt: '2026-08-03T18:00:00.000Z',
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
        userPermission: accepted ? 'write' : 'none',
        accessibleToUser: accepted,
        lastReconciledAt: '2026-08-03T18:00:00.000Z',
      },
    ],
  }
}
