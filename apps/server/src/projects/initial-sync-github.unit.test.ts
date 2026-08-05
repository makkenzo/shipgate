import { describe, expect, it } from 'vitest'
import { createProjectionFingerprint } from './initial-sync-github.js'
import type { RepositoryProjectionSnapshot } from './model.js'

const sourceSha = 'a'.repeat(40)
const productionSha = 'b'.repeat(40)

function snapshot(observedAt: Date): RepositoryProjectionSnapshot {
  return {
    installationId: 12,
    ownerId: 34,
    ownerLogin: 'octocat',
    repositoryName: 'shipgate',
    repositoryFullName: 'octocat/shipgate',
    defaultBranch: 'main',
    sourceSha,
    productionSha,
    mergeBaseSha: productionSha,
    observedAt,
    branches: [
      {
        name: 'develop',
        headSha: sourceSha,
        protected: true,
        defaultBranch: false,
      },
      {
        name: 'main',
        headSha: productionSha,
        protected: true,
        defaultBranch: true,
      },
    ],
    commits: [],
    changes: [],
    requiredChecks: [],
    checkResults: [],
    issues: [],
  }
}

describe('repository projection fingerprint', () => {
  it('does not classify observation time alone as drift', () => {
    expect(createProjectionFingerprint(snapshot(new Date('2026-08-05T00:00:00.000Z')))).toBe(
      createProjectionFingerprint(snapshot(new Date('2026-08-05T06:00:00.000Z'))),
    )
  })

  it('normalizes GitHub numeric identity and collection order', () => {
    const current = snapshot(new Date('2026-08-05T00:00:00.000Z'))
    const normalized: RepositoryProjectionSnapshot = {
      ...current,
      installationId: '12',
      ownerId: '34',
      branches: [...current.branches].reverse(),
    }

    expect(createProjectionFingerprint(normalized)).toBe(createProjectionFingerprint(current))
  })

  it('ignores check-result observation time when GitHub evidence is unchanged', () => {
    const current = snapshot(new Date('2026-08-05T00:00:00.000Z'))
    const withResult = (observedAt: Date): RepositoryProjectionSnapshot => ({
      ...current,
      checkResults: [
        {
          commitSha: sourceSha,
          type: 'check_run',
          context: 'ci',
          integrationId: 42,
          githubObjectId: 101,
          attempt: 1,
          status: 'completed',
          conclusion: 'success',
          detailsUrl: 'https://github.example/checks/101',
          startedAt: new Date('2026-08-05T00:00:00.000Z'),
          completedAt: new Date('2026-08-05T00:01:00.000Z'),
          observedAt,
        },
      ],
    })

    expect(createProjectionFingerprint(withResult(new Date('2026-08-05T00:02:00.000Z')))).toBe(
      createProjectionFingerprint(withResult(new Date('2026-08-05T06:00:00.000Z'))),
    )
  })

  it('changes when semantic repository metadata changes', () => {
    const current = snapshot(new Date('2026-08-05T00:00:00.000Z'))

    expect(createProjectionFingerprint({ ...current, ownerLogin: 'renamed-owner' })).not.toBe(
      createProjectionFingerprint(current),
    )
  })
})
