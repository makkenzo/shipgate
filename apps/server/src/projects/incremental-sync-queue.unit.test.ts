import { describe, expect, it } from 'vitest'

import {
  mergeRepositoryIncrementalSyncScopes,
  normalizeRepositoryIncrementalSyncScope,
  parseRepositoryIncrementalSyncScope,
} from './incremental-sync-queue.js'

describe('repository incremental synchronization scope', () => {
  it('normalizes duplicate webhook scope deterministically', () => {
    expect(
      normalizeRepositoryIncrementalSyncScope({
        reasons: ['push', ' push ', 'status'],
        deliveryIds: ['delivery-b', 'delivery-a', 'delivery-b'],
        branchNames: ['main', 'develop', 'main'],
        pullRequestNumbers: [8, 3, 8],
        commitShas: ['A'.repeat(40), 'a'.repeat(40), 'b'.repeat(40)],
        forced: true,
      }),
    ).toEqual({
      reasons: ['push', 'status'],
      installationId: null,
      deliveryIds: ['delivery-a', 'delivery-b'],
      branchNames: ['develop', 'main'],
      pullRequestNumbers: [3, 8],
      commitShas: ['a'.repeat(40), 'b'.repeat(40)],
      beforeShas: [],
      afterShas: [],
      forced: true,
      refreshMetadata: false,
      requireReconciliation: false,
    })
  })

  it('coalesces pending jobs by expanding rather than replacing their scope', () => {
    const merged = mergeRepositoryIncrementalSyncScopes(
      normalizeRepositoryIncrementalSyncScope({
        reasons: ['first_push'],
        installationId: '10',
        branchNames: ['develop'],
        beforeShas: ['a'.repeat(40)],
      }),
      normalizeRepositoryIncrementalSyncScope({
        reasons: ['second_push'],
        installationId: '11',
        branchNames: ['main'],
        afterShas: ['b'.repeat(40)],
        forced: true,
        refreshMetadata: true,
        requireReconciliation: true,
      }),
    )

    expect(merged).toEqual(
      expect.objectContaining({
        reasons: ['first_push', 'second_push'],
        installationId: '11',
        branchNames: ['develop', 'main'],
        beforeShas: ['a'.repeat(40)],
        afterShas: ['b'.repeat(40)],
        forced: true,
        refreshMetadata: true,
        requireReconciliation: true,
      }),
    )
    expect(parseRepositoryIncrementalSyncScope(JSON.parse(JSON.stringify(merged)))).toEqual(merged)
  })
})
