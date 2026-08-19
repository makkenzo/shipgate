import { describe, expect, it } from 'vitest'

import type { ProjectChange, ReleaseBlocker } from '@/api/projects'
import { describeReleaseBlocker, parseReleaseEvaluationSummary } from './release-planning.js'

const evaluatedAgainst = {
  sourceSha: 'a'.repeat(40),
  productionSha: 'b'.repeat(40),
  configurationVersion: 3,
  projectionVersion: 7,
}

const blocker = (overrides: Partial<ReleaseBlocker> = {}): ReleaseBlocker => ({
  code: 'qa_pending',
  changeId: 'change-a',
  dependencyChangeId: null,
  checkName: null,
  commitSha: null,
  ...overrides,
})

describe('release planning presentation', () => {
  it('accepts the deterministic server evaluation shape and rejects mismatched order', () => {
    const summary = {
      status: 'blocked',
      includedChanges: [
        {
          changeId: 'change-a',
          pullRequestNumber: 481,
          mergedAt: '2026-08-18T09:00:00.000Z',
          status: 'blocked',
          blockers: [blocker()],
        },
      ],
      excludedChanges: [],
      orderedChanges: ['change-a'],
      blockers: [blocker()],
      evaluatedAgainst,
    }

    expect(parseReleaseEvaluationSummary(summary)).toEqual(summary)
    expect(parseReleaseEvaluationSummary({ ...summary, orderedChanges: ['other'] })).toBeNull()
  })

  it('renders concrete change, dependency and repository blocker text', () => {
    const changesById = new Map<string, Pick<ProjectChange, 'id' | 'pullRequestNumber' | 'title'>>([
      ['change-a', { id: 'change-a', pullRequestNumber: 492, title: 'New checkout' }],
      ['change-b', { id: 'change-b', pullRequestNumber: 481, title: 'Payment retries' }],
    ])
    const input = { changesById, sourceBranch: 'master', productionBranch: 'prod' }

    expect(describeReleaseBlocker(blocker(), input)).toEqual({
      subject: '#492 New checkout',
      message: 'QA has not passed',
    })
    expect(
      describeReleaseBlocker(
        blocker({ code: 'dependency_excluded', dependencyChangeId: 'change-b' }),
        input,
      ),
    ).toEqual({
      subject: '#492 New checkout',
      message: 'Depends on excluded PR #481',
    })
    expect(
      describeReleaseBlocker(
        blocker({
          code: 'unmanaged_change',
          changeId: null,
          commitSha: 'c'.repeat(40),
        }),
        input,
      ),
    ).toEqual({
      subject: 'Repository',
      message: 'Unmanaged commit cccccccc exists between prod and master',
    })
  })
})
