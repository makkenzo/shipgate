import type { JsonValue, RepositoryReconciliationClassification } from '@shipgate/database'
import type { RepositoryIncrementalSyncScope } from './incremental-sync-queue.js'
import type { RepositoryHistoryRelation } from './initial-sync-github.js'

export interface RepositoryDifferenceInput {
  readonly previousSourceSha: string | null
  readonly previousProductionSha: string | null
  readonly currentSourceSha: string
  readonly currentProductionSha: string
  readonly previousProjectionFingerprint: string | null
  readonly currentProjectionFingerprint: string
  readonly sourceHistory: RepositoryHistoryRelation | null
  readonly productionHistory: RepositoryHistoryRelation | null
  readonly forcePush: boolean
  readonly triggerScope: RepositoryIncrementalSyncScope
  readonly coalescedCount: number
  readonly unresolvedUnknownChangeCount: number
}

export interface RepositoryDifference {
  readonly classification: Extract<
    RepositoryReconciliationClassification,
    'expected_change' | 'recoverable_drift' | 'destructive_history_change' | 'unknown_inconsistency'
  >
  readonly summary: JsonValue
}

export function classifyRepositoryDifference(
  input: RepositoryDifferenceInput,
): RepositoryDifference {
  const sourceHeadChanged = input.previousSourceSha !== input.currentSourceSha
  const productionHeadChanged = input.previousProductionSha !== input.currentProductionSha
  const projectionChanged =
    input.previousProjectionFingerprint !== null &&
    input.previousProjectionFingerprint !== input.currentProjectionFingerprint
  const destructiveHistory =
    input.forcePush ||
    input.sourceHistory === 'rewritten' ||
    input.productionHistory === 'rewritten'

  const expectedSameHeadChange = hasExpectedSameHeadChange(input.triggerScope)
  const classification = destructiveHistory
    ? 'destructive_history_change'
    : input.unresolvedUnknownChangeCount > 0
      ? 'unknown_inconsistency'
      : !sourceHeadChanged && !productionHeadChanged && projectionChanged && !expectedSameHeadChange
        ? 'recoverable_drift'
        : 'expected_change'

  return {
    classification,
    summary: {
      previous: {
        sourceSha: input.previousSourceSha,
        productionSha: input.previousProductionSha,
        projectionFingerprint: input.previousProjectionFingerprint,
      },
      current: {
        sourceSha: input.currentSourceSha,
        productionSha: input.currentProductionSha,
        projectionFingerprint: input.currentProjectionFingerprint,
      },
      history: {
        source: input.sourceHistory,
        production: input.productionHistory,
      },
      sourceHeadChanged,
      productionHeadChanged,
      projectionChanged,
      expectedSameHeadChange,
      forcePush: input.forcePush,
      coalescedCount: input.coalescedCount,
      unresolvedUnknownChangeCount: input.unresolvedUnknownChangeCount,
      triggerScope: scopeToJson(input.triggerScope),
    },
  }
}
function hasExpectedSameHeadChange(scope: RepositoryIncrementalSyncScope): boolean {
  return (
    scope.refreshMetadata ||
    scope.reasons.some(
      (reason) =>
        reason === 'branch_configuration_changed' ||
        reason === 'project_required_check_overrides_changed' ||
        reason === 'installation_unsuspended' ||
        reason.startsWith('github_repository_'),
    )
  )
}

function scopeToJson(scope: RepositoryIncrementalSyncScope): JsonValue {
  return {
    reasons: scope.reasons,
    installationId: scope.installationId,
    deliveryIds: scope.deliveryIds,
    branchNames: scope.branchNames,
    pullRequestNumbers: scope.pullRequestNumbers,
    commitShas: scope.commitShas,
    beforeShas: scope.beforeShas,
    afterShas: scope.afterShas,
    forced: scope.forced,
    refreshMetadata: scope.refreshMetadata,
    requireReconciliation: scope.requireReconciliation,
  }
}
