import type { GitHubResponse, InstallationGitHubClient } from '@shipgate/github'
import { describe, expect, it } from 'vitest'

import type { CommitCheckResultProjection } from './model.js'
import {
  loadCheckResultsForCommit,
  loadEffectiveRequiredChecks,
  resolveRequiredCheck,
} from './required-checks.js'

const sha = 'a'.repeat(40)
const observedAt = new Date('2026-08-05T00:00:00.000Z')

describe('required-check GitHub projection', () => {
  it('combines branch protection, active rules and project overrides deterministically', async () => {
    const client = githubClient(async (route) => {
      if (route.includes('/protection/required_status_checks')) {
        return {
          checks: [{ context: 'ci', app_id: 42 }],
          contexts: ['ci', 'legacy'],
        }
      }

      if (route === 'GET /repos/{owner}/{repo}/rules/branches/{branch}') {
        return [
          {
            type: 'required_status_checks',
            ruleset_id: 9,
            ruleset_source_type: 'Repository',
            ruleset_source: 'octocat/shipgate',
            parameters: {
              required_status_checks: [
                { context: 'ci', integration_id: 42 },
                { context: 'lint', integration_id: null },
              ],
            },
          },
        ]
      }

      throw new Error(`Unexpected route ${route}`)
    })

    await expect(
      loadEffectiveRequiredChecks({
        client,
        repository: { ownerLogin: 'octocat', name: 'shipgate' },
        sourceBranch: 'develop',
        overrides: [
          { context: 'ci', integrationId: 42 },
          { context: 'manual', integrationId: null },
        ],
      }),
    ).resolves.toEqual([
      {
        context: 'ci',
        integrationId: 42,
        source: 'project_override',
        sourceReference: null,
      },
      {
        context: 'legacy',
        integrationId: null,
        source: 'branch_protection',
        sourceReference: 'develop',
      },
      {
        context: 'lint',
        integrationId: null,
        source: 'repository_ruleset',
        sourceReference: 'Repository:octocat/shipgate:9',
      },
      {
        context: 'manual',
        integrationId: null,
        source: 'project_override',
        sourceReference: null,
      },
    ])
  })

  it('loads check runs and commit statuses only for the requested final head SHA', async () => {
    const finalHeadSha = 'b'.repeat(40)
    const routes: string[] = []
    const client = githubClient(async (route, parameters) => {
      routes.push(`${route}:${String(parameters?.ref)}`)

      if (route.endsWith('/check-runs')) {
        return {
          total_count: 1,
          check_runs: [
            {
              id: 101,
              name: 'ci',
              head_sha: finalHeadSha,
              app: { id: 42 },
              run_attempt: 2,
              status: 'completed',
              conclusion: 'neutral',
              details_url: 'https://github.example/checks/101',
              started_at: '2026-08-05T00:00:00.000Z',
              completed_at: '2026-08-05T00:01:00.000Z',
            },
          ],
        }
      }

      if (route.endsWith('/statuses')) {
        return [
          {
            id: 202,
            sha: finalHeadSha,
            context: 'ci',
            state: 'success',
            target_url: 'https://ci.example/status/202',
            created_at: '2026-08-05T00:00:30.000Z',
            updated_at: '2026-08-05T00:01:30.000Z',
          },
        ]
      }

      throw new Error(`Unexpected route ${route}`)
    })

    const results = await loadCheckResultsForCommit({
      client,
      repository: { ownerLogin: 'octocat', name: 'shipgate' },
      commitSha: finalHeadSha,
      observedAt,
    })

    expect(routes).toEqual([
      `GET /repos/{owner}/{repo}/commits/{ref}/check-runs:${finalHeadSha}`,
      `GET /repos/{owner}/{repo}/commits/{ref}/statuses:${finalHeadSha}`,
    ])
    expect(results).toEqual([
      expect.objectContaining({
        commitSha: finalHeadSha,
        type: 'check_run',
        context: 'ci',
        integrationId: 42,
        githubObjectId: 101,
        attempt: 2,
        status: 'completed',
        conclusion: 'neutral',
      }),
      expect.objectContaining({
        commitSha: finalHeadSha,
        type: 'commit_status',
        context: 'ci',
        integrationId: null,
        githubObjectId: 202,
        status: 'completed',
        conclusion: 'success',
      }),
    ])
  })
})

describe('required-check resolution', () => {
  it('requires both the latest check run and commit status when GitHub exposes both', () => {
    const result = resolveRequiredCheck({ context: 'ci', integrationId: null }, [
      observation({ type: 'check_run', githubObjectId: 1, conclusion: 'success' }),
      observation({ type: 'commit_status', githubObjectId: 2, conclusion: 'failure' }),
    ])

    expect(result.state).toBe('failed')
    expect(result.observations).toHaveLength(2)
  })

  it('matches an integration-specific requirement only to that GitHub App check run', () => {
    const result = resolveRequiredCheck({ context: 'ci', integrationId: 42 }, [
      observation({ type: 'commit_status', githubObjectId: 1, conclusion: 'success' }),
      observation({
        type: 'check_run',
        githubObjectId: 2,
        integrationId: 41,
        conclusion: 'success',
      }),
      observation({
        type: 'check_run',
        githubObjectId: 3,
        integrationId: 42,
        conclusion: 'neutral',
      }),
    ])

    expect(result.state).toBe('successful')
    expect(result.observations.map((item) => item.githubObjectId)).toEqual(['3'])
  })

  it('distinguishes pending, stale and missing observations', () => {
    expect(
      resolveRequiredCheck({ context: 'ci', integrationId: null }, [
        observation({ status: 'in_progress', conclusion: null }),
      ]).state,
    ).toBe('pending')
    expect(
      resolveRequiredCheck({ context: 'ci', integrationId: null }, [
        observation({ conclusion: 'stale' }),
      ]).state,
    ).toBe('stale')
    expect(resolveRequiredCheck({ context: 'missing', integrationId: null }, []).state).toBe(
      'missing',
    )
  })

  it('marks an otherwise successful observation stale after GitHub freshness expires', () => {
    const completedAt = new Date(observedAt.getTime() - 8 * 24 * 60 * 60_000)
    const result = resolveRequiredCheck({ context: 'ci', integrationId: null }, [
      observation({ startedAt: completedAt, completedAt }),
    ])

    expect(result.state).toBe('stale')
  })

  it('keeps a known failure authoritative when another required surface is pending', () => {
    const result = resolveRequiredCheck({ context: 'ci', integrationId: null }, [
      observation({ type: 'check_run', status: 'in_progress', conclusion: null }),
      observation({ type: 'commit_status', githubObjectId: 2, conclusion: 'failure' }),
    ])

    expect(result.state).toBe('failed')
  })

  it.each(['success', 'neutral', 'skipped'] as const)(
    'treats %s as a successful required-check conclusion',
    (conclusion) => {
      expect(
        resolveRequiredCheck({ context: 'ci', integrationId: null }, [observation({ conclusion })])
          .state,
      ).toBe('successful')
    },
  )
})

function observation(
  overrides: Partial<CommitCheckResultProjection> = {},
): CommitCheckResultProjection {
  return {
    commitSha: sha,
    type: 'check_run',
    context: 'ci',
    integrationId: 42,
    githubObjectId: 1,
    attempt: 1,
    status: 'completed',
    conclusion: 'success',
    detailsUrl: null,
    startedAt: observedAt,
    completedAt: observedAt,
    observedAt,
    ...overrides,
  }
}

function githubClient(
  handler: (
    route: string,
    parameters: Readonly<Record<string, unknown>> | undefined,
  ) => Promise<unknown>,
): InstallationGitHubClient {
  return {
    authentication: {
      type: 'installation',
      installationId: 123,
      repositoryIds: [456],
      permissions: {
        metadata: 'read',
        checks: 'read',
        statuses: 'read',
        administration: 'read',
      },
    },
    async request<Data = unknown>(
      route: string,
      parameters?: Readonly<Record<string, unknown>>,
    ): Promise<GitHubResponse<Data>> {
      return {
        data: (await handler(route, parameters)) as Data,
        status: 200,
        headers: {},
        url: 'https://api.github.test/fixture',
      }
    },
    async graphql<Data = unknown>(): Promise<Data> {
      return {} as Data
    },
  }
}
