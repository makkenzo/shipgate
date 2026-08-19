import { describe, expect, it } from 'vitest'

import {
  evaluateRelease,
  type ReleaseBlockerCode,
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

  it('returns one ready PR with no blockers', () => {
    const change = readyChange('A', 481, '2026-08-18T09:00:00.000Z')
    const evaluation = evaluateRelease(singleChangeInput(change))

    expect(evaluation).toMatchObject({
      status: 'ready',
      orderedChanges: ['A'],
      includedChanges: [{ changeId: 'A', status: 'ready', blockers: [] }],
      blockers: [],
    })
  })

  const blockerCases: readonly (readonly [
    name: string,
    override: Partial<ReleaseEvaluationChangeInput>,
    expectedCode: ReleaseBlockerCode,
  ])[] = [
    ['QA pending', { qaStatus: 'pending' }, 'qa_pending'],
    ['QA failed', { qaStatus: 'failed' }, 'qa_failed'],
    [
      'check failed',
      { requiredChecks: [{ name: 'ci', state: 'failed' }] },
      'required_check_failed',
    ],
    [
      'check pending',
      { requiredChecks: [{ name: 'ci', state: 'pending' }] },
      'required_check_pending',
    ],
    [
      'missing check',
      { requiredChecks: [{ name: 'ci', state: 'missing' }] },
      'required_check_missing',
    ],
    [
      'partial production presence',
      { productionPresence: 'partially_released' },
      'partially_released_change',
    ],
    ['ambiguous change attribution', { commitAttribution: 'ambiguous' }, 'ambiguous_change'],
  ]

  it.each(blockerCases)('blocks a change for %s', (_name, override, expectedCode) => {
    const change = {
      ...readyChange('A', 481, '2026-08-18T09:00:00.000Z'),
      ...override,
    }
    const evaluation = evaluateRelease(singleChangeInput(change))

    expect(evaluation.status).toBe('blocked')
    expect(evaluation.blockers.map((blocker) => blocker.code)).toContain(expectedCode)
  })

  it('blocks repository-level unmanaged and ambiguous commits independently of PR gates', () => {
    const input = singleChangeInput(readyChange('A', 481, '2026-08-18T09:00:00.000Z'))
    const evaluation = evaluateRelease({
      ...input,
      unmanagedCommits: [{ sha: '1'.repeat(40) }],
      ambiguousCommits: [{ sha: '2'.repeat(40) }],
    })

    expect(evaluation.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unmanaged_change', commitSha: '1'.repeat(40) }),
        expect.objectContaining({ code: 'ambiguous_change', commitSha: '2'.repeat(40) }),
      ]),
    )
  })

  it('keeps an excluded PR out of the included set without treating exclusion itself as a blocker', () => {
    const input = singleChangeInput(readyChange('A', 481, '2026-08-18T09:00:00.000Z'))
    const evaluation = evaluateRelease({ ...input, excludedChangeIds: ['A'] })

    expect(evaluation.status).toBe('ready')
    expect(evaluation.includedChanges).toEqual([])
    expect(evaluation.excludedChanges).toMatchObject([{ changeId: 'A', status: 'excluded' }])
    expect(evaluation.blockers).toEqual([])
  })

  it('orders a ready dependency before its dependent and remains ready', () => {
    const dependency = readyChange('B', 481, '2026-08-18T09:05:00.000Z')
    const dependent = readyChange('A', 492, '2026-08-18T09:00:00.000Z')
    const input = singleChangeInput(dependent)
    const evaluation = evaluateRelease({
      ...input,
      candidateChangeIds: ['A', 'B'],
      changes: [dependent, dependency],
      dependencies: [{ dependentChangeId: 'A', prerequisiteChangeId: 'B' }],
    })

    expect(evaluation.status).toBe('ready')
    expect(evaluation.orderedChanges).toEqual(['B', 'A'])
  })

  it('treats an already released dependency as satisfied', () => {
    const dependent = readyChange('A', 492, '2026-08-18T09:00:00.000Z')
    const releasedDependency = {
      ...readyChange('B', 481, '2026-08-17T09:00:00.000Z'),
      productionPresence: 'released' as const,
    }
    const evaluation = evaluateRelease({
      ...singleChangeInput(dependent),
      changes: [dependent, releasedDependency],
      dependencies: [{ dependentChangeId: 'A', prerequisiteChangeId: 'B' }],
    })

    expect(evaluation.status).toBe('ready')
    expect(evaluation.blockers).toEqual([])
  })

  it('blocks a dependent when its prerequisite is excluded', () => {
    const dependent = readyChange('A', 492, '2026-08-18T09:00:00.000Z')
    const dependency = readyChange('B', 481, '2026-08-18T08:00:00.000Z')
    const evaluation = evaluateRelease({
      ...singleChangeInput(dependent),
      candidateChangeIds: ['A', 'B'],
      excludedChangeIds: ['B'],
      changes: [dependent, dependency],
      dependencies: [{ dependentChangeId: 'A', prerequisiteChangeId: 'B' }],
    })

    expect(evaluation.status).toBe('blocked')
    expect(evaluation.blockers).toContainEqual(
      expect.objectContaining({
        code: 'dependency_excluded',
        changeId: 'A',
        dependencyChangeId: 'B',
      }),
    )
  })

  it('blocks every candidate when the Project is degraded', () => {
    const input = singleChangeInput(readyChange('A', 481, '2026-08-18T09:00:00.000Z'))
    const evaluation = evaluateRelease({
      ...input,
      project: { ...input.project, status: 'degraded' },
    })

    expect(evaluation.status).toBe('blocked')
    expect(evaluation.blockers).toContainEqual(
      expect.objectContaining({ code: 'project_degraded', changeId: null }),
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

function singleChangeInput(change: ReleaseEvaluationChangeInput): ReleaseEvaluationInput {
  return {
    project: { status: 'active', permission: 'granted' },
    candidateChangeIds: [change.id],
    excludedChangeIds: [],
    changes: [change],
    dependencies: [],
    evaluatedAgainst: {
      sourceSha: 'a'.repeat(40),
      productionSha: 'b'.repeat(40),
      configurationVersion: 3,
      projectionVersion: 7,
    },
  }
}
