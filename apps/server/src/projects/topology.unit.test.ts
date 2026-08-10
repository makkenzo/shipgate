import type {
  GitHubAuthenticationService,
  GitHubResponse,
  InstallationGitHubClient,
} from '@shipgate/github'
import { describe, expect, it, vi } from 'vitest'

import type { GitAncestryWorkspace } from './git-workspace.js'
import { createProjectTopologyValidator } from './topology.js'

const sourceSha = '2'.repeat(40)
const productionSha = '1'.repeat(40)

describe('project topology validator', () => {
  it('uses exact commit refs, Compare API, and the final Git workspace check', async () => {
    const assertProductionAncestor = vi.fn(async () => undefined)
    const validator = createProjectTopologyValidator({
      githubAuth: createGitHubAuth('ahead'),
      gitWorkspace: { assertProductionAncestor } satisfies GitAncestryWorkspace,
    })

    await expect(
      validator.validate({
        installationId: 123,
        repositoryId: 456,
        sourceBranch: 'develop',
        productionBranch: 'main',
      }),
    ).resolves.toMatchObject({
      repositoryFullName: 'octocat/shipgate',
      sourceSha,
      productionSha,
      compareStatus: 'ahead',
    })
    expect(assertProductionAncestor).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: 'develop',
        productionBranch: 'main',
        sourceSha,
        productionSha,
      }),
    )
  })

  it('rejects identical source and production branches before contacting GitHub', async () => {
    const getInstallationClient = vi.fn(async () => {
      throw new Error('GitHub must not be contacted')
    })
    const validator = createProjectTopologyValidator({
      githubAuth: {
        ...createGitHubAuth('ahead'),
        getInstallationClient,
      },
      gitWorkspace: { assertProductionAncestor: vi.fn(async () => undefined) },
    })

    await expect(
      validator.validate({
        installationId: 123,
        repositoryId: 456,
        sourceBranch: 'main',
        productionBranch: 'main',
      }),
    ).rejects.toMatchObject({ code: 'source_equals_production' })
    expect(getInstallationClient).not.toHaveBeenCalled()
  })

  it.each([
    ['source', 'source_branch_missing'],
    ['production', 'production_branch_missing'],
  ] as const)('reports a missing %s branch precisely', async (missingBranch, expectedCode) => {
    const assertProductionAncestor = vi.fn(async () => undefined)
    const validator = createProjectTopologyValidator({
      githubAuth: createGitHubAuth('ahead', 'commit', missingBranch),
      gitWorkspace: { assertProductionAncestor } satisfies GitAncestryWorkspace,
    })

    await expect(
      validator.validate({
        installationId: 123,
        repositoryId: 456,
        sourceBranch: 'develop',
        productionBranch: 'main',
      }),
    ).rejects.toMatchObject({ code: expectedCode })
    expect(assertProductionAncestor).not.toHaveBeenCalled()
  })

  it('rejects a diverged Compare result before creating a Git workspace', async () => {
    const assertProductionAncestor = vi.fn(async () => undefined)
    const validator = createProjectTopologyValidator({
      githubAuth: createGitHubAuth('diverged'),
      gitWorkspace: { assertProductionAncestor } satisfies GitAncestryWorkspace,
    })

    await expect(
      validator.validate({
        installationId: 123,
        repositoryId: 456,
        sourceBranch: 'develop',
        productionBranch: 'main',
      }),
    ).rejects.toMatchObject({ code: 'production_branch_not_ancestor' })
    expect(assertProductionAncestor).not.toHaveBeenCalled()
  })

  it('rejects a ref that does not point directly to a commit', async () => {
    const validator = createProjectTopologyValidator({
      githubAuth: createGitHubAuth('ahead', 'tag'),
      gitWorkspace: { assertProductionAncestor: vi.fn(async () => undefined) },
    })

    await expect(
      validator.validate({
        installationId: 123,
        repositoryId: 456,
        sourceBranch: 'develop',
        productionBranch: 'main',
      }),
    ).rejects.toMatchObject({ code: 'source_ref_not_commit' })
  })
})

function createGitHubAuth(
  compareStatus: 'ahead' | 'diverged',
  sourceObjectType: 'commit' | 'tag' = 'commit',
  missingBranch?: 'source' | 'production',
): GitHubAuthenticationService {
  const client: InstallationGitHubClient = {
    authentication: {
      type: 'installation',
      installationId: 123,
      repositoryIds: [456],
      permissions: { metadata: 'read', contents: 'read' },
    },
    async request<Data = unknown>(
      route: string,
      parameters?: Readonly<Record<string, unknown>>,
    ): Promise<GitHubResponse<Data>> {
      if (route === 'GET /repositories/{repository_id}') {
        return response<Data>({
          id: 456,
          owner: { id: 99, login: 'octocat' },
          name: 'shipgate',
          full_name: 'octocat/shipgate',
          clone_url: 'https://github.com/octocat/shipgate.git',
          default_branch: 'main',
          archived: false,
          disabled: false,
        })
      }

      if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
        const ref = parameters?.ref
        const source = ref === 'heads/develop'

        if ((missingBranch === 'source' && source) || (missingBranch === 'production' && !source)) {
          throw Object.assign(new Error('branch not found'), { status: 404 })
        }

        return response<Data>({
          ref: source ? 'refs/heads/develop' : 'refs/heads/main',
          object: {
            type: source ? sourceObjectType : 'commit',
            sha: source ? sourceSha : productionSha,
          },
        })
      }

      if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') {
        return response<Data>({ status: compareStatus })
      }

      return response<Data>({})
    },
    async graphql<Data = unknown>() {
      return {} as Data
    },
  }

  return {
    async getAppClient() {
      throw new Error('not used')
    },
    async getInstallationClient() {
      return client
    },
    async withInstallationToken(_input, callback) {
      return callback({ token: 'installation-token', expiresAt: new Date(Date.now() + 60_000) })
    },
    async getUserClient() {
      throw new Error('not used')
    },
    async authorizeUser() {
      throw new Error('not used')
    },
    invalidateInstallation() {},
    invalidateUser() {},
    async revokeUser() {},
    async disconnectUser() {},
  }
}

function response<Data>(data: unknown): GitHubResponse<Data> {
  return {
    data: data as Data,
    status: 200,
    headers: {},
    url: 'https://api.github.test/fixture',
  }
}
