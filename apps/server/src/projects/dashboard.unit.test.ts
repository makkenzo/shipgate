import { describe, expect, it } from 'vitest'

import { summarizeProjectCheckState } from './dashboard.js'

describe('project dashboard required-check summary', () => {
  it('distinguishes no policy from a configured policy with missing results', () => {
    expect(
      summarizeProjectCheckState({
        configuredCheckCount: 0,
        hasKnownChangesAhead: true,
        states: [],
      }),
    ).toBe('not_configured')

    expect(
      summarizeProjectCheckState({
        configuredCheckCount: 2,
        hasKnownChangesAhead: true,
        expectedStateCount: 2,
        states: ['successful'],
      }),
    ).toBe('missing')
  })

  it('keeps unknown change identity authoritative over observed check results', () => {
    expect(
      summarizeProjectCheckState({
        configuredCheckCount: 1,
        hasKnownChangesAhead: true,
        expectedStateCount: 1,
        synchronizationState: 'unknown',
        states: ['successful'],
      }),
    ).toBe('unknown')
  })
})
