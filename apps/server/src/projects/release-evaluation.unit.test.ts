import { describe, expect, it } from 'vitest'

import {
  evaluateRelease,
  type ReleaseEvaluationChangeInput,
  type ReleaseEvaluationInput,
} from './release-evaluation.js'

const readyChange = (
  id: string,
  pullRequestNumber: number,
  mergedAt: string,
): ReleaseEvaluationChangeInput => ({
  id,
  pullRequestNumber,
  mergedAt,
  synchronizationState: 'valid',
  productionPresence: 'unreleased',
  qaStatus: 'passed',
  requiredChecks: [{ name: 'ci', state: 'successful' }],
  commitAttribution: 'managed',
  commitSetFingerprint: id.repeat(64).slice(0, 64),
})

const baseInput = (): ReleaseEvaluationInput => ({
  project: { status: 'active', permission: 'granted' },
  candidateChangeIds: ['A', 'B', 'C'],
  excludedChangeIds: [],
  changes: [
    readyChange('A', 30, '2026-08-03T12:00:00.000Z'),
    readyChange('B', 20, '2026-08-04T12:00:00.000Z'),
    readyChange('C', 10, '2026-08-01T12:00:00.000Z'),
  ],
  dependencies: [{ dependentChangeId: 'A', prerequisiteChangeId: 'B' }],
  evaluatedAgainst: {
    sourceSha: 'a'.repeat(40),
    productionSha: 'b'.repeat(40),
    configurationVersion: 3,
    projectionVersion: 7,
  },
})

describe('evaluateRelease', () => {
  it('returns a deterministic topological order with merge time and PR number tie-breaks', () => {
    const evaluation = evaluateRelease(baseInput())

    expect(evaluation.status).toBe('ready')
    expect(evaluation.orderedChanges).toEqual(['C', 'B', 'A'])
    expect(evaluation.includedChanges.every((change) => change.status === 'ready')).toBe(true)
    expect(evaluation.blockers).toEqual([])
  })

  it('uses exact blocker codes and resolves only released or earlier included dependencies', () => {
    const input = baseInput()
    const [changeA, changeB, changeC] = input.changes

    if (!changeA || !changeB || !changeC) {
      throw new Error('Expected the base release-evaluation fixture to contain three changes')
    }

    const failedB = {
      ...changeB,
      qaStatus: 'failed' as const,
      requiredChecks: [
        { name: 'ci', state: 'failed' as const },
        { name: 'security', state: 'missing' as const },
      ],
    }
    const evaluation = evaluateRelease({
      ...input,
      changes: [changeA, failedB, changeC],
      excludedChangeIds: ['C'],
      dependencies: [
        { dependentChangeId: 'A', prerequisiteChangeId: 'B' },
        { dependentChangeId: 'A', prerequisiteChangeId: 'C' },
      ],
    })

    expect(evaluation.status).toBe('blocked')
    expect(
      evaluation.blockers
        .filter((blocker) => blocker.changeId === 'A')
        .map((blocker) => blocker.code),
    ).toEqual(['dependency_excluded', 'dependency_not_ready'])
    expect(
      evaluation.blockers
        .filter((blocker) => blocker.changeId === 'B')
        .map((blocker) => blocker.code),
    ).toEqual(['qa_failed', 'required_check_missing', 'required_check_failed'])
    expect(evaluation.excludedChanges).toMatchObject([{ changeId: 'C', status: 'excluded' }])
  })

  it('blocks cycles and unmanaged or ambiguous commits without a generic blocker', () => {
    const input = baseInput()
    const evaluation = evaluateRelease({
      ...input,
      dependencies: [
        { dependentChangeId: 'A', prerequisiteChangeId: 'B' },
        { dependentChangeId: 'B', prerequisiteChangeId: 'A' },
      ],
      unmanagedCommits: [{ sha: '1'.repeat(40) }],
      ambiguousCommits: [{ sha: '2'.repeat(40) }],
    })

    expect(evaluation.status).toBe('blocked')
    expect(evaluation.blockers.map((blocker) => blocker.code)).toContain('dependency_cycle')
    expect(evaluation.blockers.map((blocker) => blocker.code)).toContain('unmanaged_change')
    expect(evaluation.blockers.map((blocker) => blocker.code)).toContain('ambiguous_change')
    expect(evaluation.blockers.map((blocker) => blocker.code)).not.toContain(
      'release_not_ready' as never,
    )
  })

  it('produces byte-for-byte equivalent data for permuted normalized input', () => {
    const input = baseInput()
    const first = evaluateRelease(input)
    const second = evaluateRelease({
      ...input,
      candidateChangeIds: [...input.candidateChangeIds].reverse(),
      changes: [...input.changes].reverse(),
      dependencies: [...input.dependencies].reverse(),
    })

    expect(second).toEqual(first)
  })
})
