import { describe, expect, it } from 'vitest'

import { normalizeRepositoryIncrementalSyncScope } from './incremental-sync-queue.js'
import { classifyRepositoryDifference } from './reconciliation.js'

const previousSourceSha = 'a'.repeat(40)
const previousProductionSha = 'b'.repeat(40)
const currentSourceSha = 'c'.repeat(40)
const currentProductionSha = 'd'.repeat(40)
const previousProjectionFingerprint = '1'.repeat(64)
const currentProjectionFingerprint = '2'.repeat(64)

function classify(overrides: Partial<Parameters<typeof classifyRepositoryDifference>[0]> = {}) {
  return classifyRepositoryDifference({
    previousSourceSha,
    previousProductionSha,
    currentSourceSha,
    currentProductionSha,
    previousProjectionFingerprint,
    currentProjectionFingerprint,
    sourceHistory: 'fast_forward',
    productionHistory: 'fast_forward',
    forcePush: false,
    triggerScope: normalizeRepositoryIncrementalSyncScope({
      reasons: ['test'],
    }),
    coalescedCount: 0,
    unresolvedUnknownChangeCount: 0,
    ...overrides,
  })
}

describe('repository reconciliation classification', () => {
  it('classifies ordinary branch movement as an expected change', () => {
    expect(classify().classification).toBe('expected_change')
  })

  it('classifies same-head projection differences as recoverable drift', () => {
    expect(
      classify({
        currentSourceSha: previousSourceSha,
        currentProductionSha: previousProductionSha,
        sourceHistory: 'identical',
        productionHistory: 'identical',
      }).classification,
    ).toBe('recoverable_drift')
  })

  it('keeps a known same-head metadata webhook as an expected change', () => {
    expect(
      classify({
        currentSourceSha: previousSourceSha,
        currentProductionSha: previousProductionSha,
        sourceHistory: 'identical',
        productionHistory: 'identical',
        triggerScope: normalizeRepositoryIncrementalSyncScope({
          reasons: ['github_repository_renamed'],
          refreshMetadata: true,
        }),
      }).classification,
    ).toBe('expected_change')
  })

  it('keeps unresolved lost identities classified as unknown inconsistency', () => {
    expect(classify({ unresolvedUnknownChangeCount: 2 }).classification).toBe(
      'unknown_inconsistency',
    )
  })

  it('classifies a rewritten branch as destructive history change', () => {
    expect(classify({ sourceHistory: 'rewritten' }).classification).toBe(
      'destructive_history_change',
    )
  })

  it('treats an explicit force-push signal as destructive even before comparison', () => {
    expect(classify({ forcePush: true }).classification).toBe('destructive_history_change')
  })
})
