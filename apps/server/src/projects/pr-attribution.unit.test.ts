import type { GitHubResponse, InstallationGitHubClient } from '@shipgate/github'
import { describe, expect, it } from 'vitest'

import type { GitRepositorySnapshot } from './git-workspace.js'
import type { RepositoryCommitProjection } from './model.js'
import { attributePullRequestChanges } from './pr-attribution.js'

const productionSha = 'a'.repeat(40)

describe('commit topology and pull request attribution', () => {
  it('attributes a merge commit from its deterministic integration window', async () => {
    const first = 'b'.repeat(40)
    const second = 'c'.repeat(40)
    const merge = 'd'.repeat(40)
    const commits = [
      createCommit(first, [productionSha], 0, null, merge),
      createCommit(second, [first], 1, null, merge),
      createCommit(merge, [productionSha, second], 2, 0, merge),
    ]
    const git = createSnapshot(commits, {
      firstParentShas: [merge],
      integrationWindows: [
        {
          integrationSha: merge,
          firstParentSha: productionSha,
          secondParentSha: second,
          firstParentPosition: 0,
          commitShas: [first, second, merge],
          introducedCommitShas: [first, second],
        },
      ],
    })
    const client = createClient({
      evidence: {
        [merge]: { rest: [11], graph: [11] },
      },
      pulls: {
        11: createPull(11, [first, second], merge),
      },
    })

    const result = await attribute(client, git, commits)

    expect(result.changes).toEqual([
      expect.objectContaining({
        pullRequestNumber: 11,
        mergeMethod: 'merge',
        commitShas: [first, second, merge],
        sourceIntegrationSha: merge,
        integrationFirstParentSha: productionSha,
        integrationSecondParentSha: second,
        productionPresence: 'unreleased',
      }),
    ])
    expect(result.commits.map((commit) => commit.attributionState)).toEqual([
      'managed',
      'managed',
      'managed',
    ])
    expect(result.issues).toEqual([])
  })

  it('marks a merge window ambiguous when GitHub PR commits are missing locally', async () => {
    const first = '9'.repeat(40)
    const second = 'a'.repeat(40)
    const merge = 'b'.repeat(40)
    const missing = 'c'.repeat(40)
    const commits = [
      createCommit(first, [productionSha], 0, null, merge),
      createCommit(second, [first], 1, null, merge),
      createCommit(merge, [productionSha, second], 2, 0, merge),
    ]
    const git = createSnapshot(commits, {
      firstParentShas: [merge],
      integrationWindows: [
        {
          integrationSha: merge,
          firstParentSha: productionSha,
          secondParentSha: second,
          firstParentPosition: 0,
          commitShas: [first, second, merge],
          introducedCommitShas: [first, second],
        },
      ],
    })
    const client = createClient({
      evidence: {
        [merge]: { rest: [17], graph: [17] },
      },
      pulls: {
        17: createPull(17, [first, missing], merge),
      },
    })

    const result = await attribute(client, git, commits)

    expect(result.changes).toEqual([])
    expect(result.commits.map((commit) => commit.attributionState)).toEqual([
      'ambiguous',
      'ambiguous',
      'ambiguous',
    ])
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ambiguous_commit_attribution',
          details: expect.objectContaining({ reason: 'pull_commits_missing_from_merge_window' }),
        }),
      ]),
    )
  })

  it('attributes a squash commit without using its commit message', async () => {
    const squash = 'e'.repeat(40)
    const original = ['1'.repeat(40), '2'.repeat(40)]
    const commits = [createCommit(squash, [productionSha], 0, 0, squash)]
    const git = createSnapshot(commits, {
      firstParentShas: [squash],
      integrationWindows: [linearWindow(squash, productionSha, 0)],
    })
    const client = createClient({
      evidence: {
        [squash]: { rest: [12], graph: [12] },
      },
      pulls: {
        12: createPull(12, original, squash),
      },
    })

    const result = await attribute(client, git, commits)

    expect(result.changes).toEqual([
      expect.objectContaining({
        pullRequestNumber: 12,
        mergeMethod: 'squash',
        commitShas: [squash],
        productionPresence: 'unreleased',
      }),
    ])
    expect(result.commits[0]?.attributionState).toBe('managed')
  })

  it('keeps a one-commit pull request managed when its linear merge method is unknowable', async () => {
    const source = '7'.repeat(40)
    const original = ['8'.repeat(40)]
    const commits = [createCommit(source, [productionSha], 0, 0, source)]
    const git = createSnapshot(commits, {
      firstParentShas: [source],
      integrationWindows: [linearWindow(source, productionSha, 0)],
    })
    const client = createClient({
      evidence: {
        [source]: { rest: [16], graph: [16] },
      },
      pulls: {
        16: createPull(16, original, source),
      },
    })

    const result = await attribute(client, git, commits)

    expect(result.commits[0]?.attributionState).toBe('managed')
    expect(result.changes).toEqual([
      expect.objectContaining({
        pullRequestNumber: 16,
        mergeMethod: 'unknown',
        commitShas: [source],
      }),
    ])
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'linear_merge_method_ambiguous', scope: 'change' }),
    ])
  })

  it('groups contiguous rebased commits and detects partial production presence', async () => {
    const first = 'f'.repeat(40)
    const second = '0'.repeat(40)
    const original = ['3'.repeat(40), '4'.repeat(40)]
    const commits = [
      createCommit(first, [productionSha], 0, 0, first, true),
      createCommit(second, [first], 1, 1, second),
    ]
    const git = createSnapshot(commits, {
      firstParentShas: [first, second],
      integrationWindows: [linearWindow(first, productionSha, 0), linearWindow(second, first, 1)],
    })
    const client = createClient({
      evidence: {
        [first]: { rest: [13], graph: [13] },
        [second]: { rest: [13], graph: [13] },
      },
      pulls: {
        13: createPull(13, original, second),
      },
    })

    const result = await attribute(client, git, commits)

    expect(result.changes).toEqual([
      expect.objectContaining({
        pullRequestNumber: 13,
        mergeMethod: 'rebase',
        commitShas: [first, second],
        sourceIntegrationSha: second,
        integrationFirstParentSha: productionSha,
        productionPresence: 'partially_present',
      }),
    ])
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'change_partially_present_in_production',
        scope: 'change',
      }),
    ])
  })

  it('persists unmanaged and contradictory commits as explicit issues', async () => {
    const unmanaged = '5'.repeat(40)
    const ambiguous = '6'.repeat(40)
    const commits = [
      createCommit(unmanaged, [productionSha], 0, 0, unmanaged),
      createCommit(ambiguous, [unmanaged], 1, 1, ambiguous),
    ]
    const git = createSnapshot(commits, {
      firstParentShas: [unmanaged, ambiguous],
      integrationWindows: [
        linearWindow(unmanaged, productionSha, 0),
        linearWindow(ambiguous, unmanaged, 1),
      ],
    })
    const client = createClient({
      evidence: {
        [ambiguous]: { rest: [14], graph: [15] },
      },
      pulls: {
        14: createPull(14, ['8'.repeat(40)], ambiguous),
        15: createPull(15, ['9'.repeat(40)], ambiguous),
      },
    })

    const result = await attribute(client, git, commits)

    expect(result.changes).toEqual([])
    expect(result.commits.map((commit) => commit.attributionState)).toEqual([
      'unmanaged',
      'ambiguous',
    ])
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unmanaged_commit',
          subjectId: unmanaged,
        }),
        expect.objectContaining({
          code: 'ambiguous_commit_attribution',
          subjectId: ambiguous,
        }),
      ]),
    )
  })
})

interface PullFixture {
  readonly id: number
  readonly number: number
  readonly originalCommitShas: readonly string[]
  readonly mergeCommitSha: string
  readonly mergedAt: string
}

function createPull(
  number: number,
  originalCommitShas: readonly string[],
  mergeCommitSha: string,
): PullFixture {
  return {
    id: 10_000 + number,
    number,
    originalCommitShas,
    mergeCommitSha,
    mergedAt: `2026-08-04T20:${String(number).padStart(2, '0')}:00.000Z`,
  }
}

function createClient(input: {
  readonly evidence: Readonly<
    Record<string, { readonly rest?: readonly number[]; readonly graph?: readonly number[] }>
  >
  readonly pulls: Readonly<Record<number, PullFixture>>
}): InstallationGitHubClient {
  return {
    authentication: {
      type: 'installation',
      installationId: 123,
      repositoryIds: [456],
      permissions: { metadata: 'read', contents: 'read', pull_requests: 'read' },
    },
    async request<Data = unknown>(
      route: string,
      parameters?: Readonly<Record<string, unknown>>,
    ): Promise<GitHubResponse<Data>> {
      if (route === 'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls') {
        const sha = String(parameters?.commit_sha ?? '')
        return response<Data>(
          (input.evidence[sha]?.rest ?? []).map((number) => {
            const pull = requirePull(input.pulls, number)
            return {
              number,
              merged_at: pull.mergedAt,
              base: { ref: 'develop' },
            }
          }),
        )
      }

      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        const number = Number(parameters?.pull_number)
        const pull = requirePull(input.pulls, number)
        return response<Data>({
          id: pull.id,
          number: pull.number,
          title: `Pull request ${pull.number}`,
          html_url: `https://github.example/octocat/shipgate/pull/${pull.number}`,
          merged_at: pull.mergedAt,
          merge_commit_sha: pull.mergeCommitSha,
          commits: pull.originalCommitShas.length,
          user: { id: 99, login: 'octocat' },
          base: { ref: 'develop' },
          head: { sha: pull.originalCommitShas.at(-1) },
        })
      }

      return response<Data>({})
    },
    async graphql<Data = unknown>(
      query: string,
      parameters?: Readonly<Record<string, unknown>>,
    ): Promise<Data> {
      if (query.includes('ShipgateAssociatedPullRequests')) {
        const sha = String(parameters?.oid ?? '')
        const nodes = (input.evidence[sha]?.graph ?? []).map((number) => {
          const pull = requirePull(input.pulls, number)
          return {
            number,
            merged: true,
            mergedAt: pull.mergedAt,
            baseRefName: 'develop',
          }
        })

        return {
          repository: {
            object: {
              associatedPullRequests: {
                nodes,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        } as Data
      }

      if (query.includes('ShipgatePullRequestCommits')) {
        const number = Number(parameters?.number)
        const pull = requirePull(input.pulls, number)
        return {
          repository: {
            pullRequest: {
              commits: {
                nodes: pull.originalCommitShas.map((oid) => ({ commit: { oid } })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        } as Data
      }

      return {} as Data
    },
  }
}

function requirePull(pulls: Readonly<Record<number, PullFixture>>, number: number): PullFixture {
  const pull = pulls[number]

  if (!pull) {
    throw new Error(`Missing pull request fixture ${number}`)
  }

  return pull
}

function createSnapshot(
  commits: readonly RepositoryCommitProjection[],
  topology: Pick<GitRepositorySnapshot, 'firstParentShas' | 'integrationWindows'>,
): GitRepositorySnapshot {
  return {
    sourceSha: commits.at(-1)?.sha ?? productionSha,
    productionSha,
    mergeBaseSha: productionSha,
    firstParentShas: topology.firstParentShas,
    integrationWindows: topology.integrationWindows,
    commits: commits.map((commit) => ({
      sha: commit.sha,
      treeSha: commit.treeSha ?? '7'.repeat(40),
      message: commit.message,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      authoredAt: commit.authoredAt,
      committerName: null,
      committerEmail: null,
      committedAt: commit.committedAt,
      parentShas: commit.parentShas,
      sourceDeltaPosition: commit.sourceDeltaPosition,
      firstParentPosition: commit.firstParentPosition,
      integrationPointSha: commit.integrationPointSha,
      productionPatchEquivalent: commit.productionPatchEquivalent,
    })),
  }
}

function createCommit(
  sha: string,
  parentShas: readonly string[],
  sourceDeltaPosition: number,
  firstParentPosition: number | null,
  integrationPointSha: string,
  productionPatchEquivalent = false,
): RepositoryCommitProjection {
  return {
    sha,
    treeSha: '7'.repeat(40),
    message: `fixture-${sha.slice(0, 8)}`,
    authorId: null,
    authorLogin: null,
    authorName: 'Shipgate Test',
    authorEmail: 'shipgate@example.test',
    committerId: null,
    committerLogin: null,
    authoredAt: new Date('2026-08-04T20:00:00.000Z'),
    committedAt: new Date('2026-08-04T20:00:00.000Z'),
    parentShas,
    sourceDeltaPosition,
    firstParentPosition,
    integrationPointSha,
    productionPatchEquivalent,
    attributionState: 'unmanaged',
  }
}

function linearWindow(
  sha: string,
  firstParentSha: string,
  firstParentPosition: number,
): GitRepositorySnapshot['integrationWindows'][number] {
  return {
    integrationSha: sha,
    firstParentSha,
    secondParentSha: null,
    firstParentPosition,
    commitShas: [sha],
    introducedCommitShas: [],
  }
}

function attribute(
  client: InstallationGitHubClient,
  git: GitRepositorySnapshot,
  commits: readonly RepositoryCommitProjection[],
) {
  return attributePullRequestChanges({
    client,
    repository: { ownerLogin: 'octocat', name: 'shipgate' },
    sourceBranch: 'develop',
    git,
    commits,
  })
}

function response<Data>(data: unknown): GitHubResponse<Data> {
  return {
    data: data as Data,
    status: 200,
    headers: {},
    url: 'https://api.github.test/fixture',
  }
}
