import type {
  ProjectChange,
  ReleaseBlocker,
  ReleaseBlockerCode,
  ReleaseEvaluationChange,
  ReleaseEvaluationSummary,
} from '@/api/projects'

const blockerCodes = new Set<ReleaseBlockerCode>([
  'qa_pending',
  'qa_failed',
  'required_check_pending',
  'required_check_failed',
  'required_check_missing',
  'dependency_not_ready',
  'dependency_excluded',
  'dependency_unknown',
  'dependency_cycle',
  'unmanaged_change',
  'ambiguous_change',
  'partially_released_change',
  'commit_set_unknown',
  'source_changed',
  'production_changed',
  'project_degraded',
  'permission_missing',
])

export function parseReleaseEvaluationSummary(value: unknown): ReleaseEvaluationSummary | null {
  if (!isRecord(value) || (value.status !== 'ready' && value.status !== 'blocked')) {
    return null
  }

  const includedChanges = parseEvaluationChanges(value.includedChanges)
  const excludedChanges = parseEvaluationChanges(value.excludedChanges)
  const blockers = parseBlockers(value.blockers)
  const orderedChanges = parseStringArray(value.orderedChanges)
  const evaluatedAgainst = value.evaluatedAgainst

  if (
    includedChanges === null ||
    excludedChanges === null ||
    blockers === null ||
    orderedChanges === null ||
    !isRecord(evaluatedAgainst) ||
    typeof evaluatedAgainst.sourceSha !== 'string' ||
    typeof evaluatedAgainst.productionSha !== 'string' ||
    !isNonNegativeInteger(evaluatedAgainst.configurationVersion) ||
    !isNonNegativeInteger(evaluatedAgainst.projectionVersion)
  ) {
    return null
  }

  const includedIds = includedChanges.map((change) => change.changeId)

  if (
    new Set(includedIds).size !== includedIds.length ||
    new Set(orderedChanges).size !== orderedChanges.length ||
    orderedChanges.length !== includedIds.length ||
    orderedChanges.some((changeId, index) => changeId !== includedIds[index])
  ) {
    return null
  }

  return {
    status: value.status,
    includedChanges,
    excludedChanges,
    orderedChanges,
    blockers,
    evaluatedAgainst: {
      sourceSha: evaluatedAgainst.sourceSha,
      productionSha: evaluatedAgainst.productionSha,
      configurationVersion: evaluatedAgainst.configurationVersion,
      projectionVersion: evaluatedAgainst.projectionVersion,
    },
  }
}

export interface ReleaseBlockerDescription {
  readonly subject: string
  readonly message: string
}

export function describeReleaseBlocker(
  blocker: ReleaseBlocker,
  input: {
    readonly changesById: ReadonlyMap<
      string,
      Pick<ProjectChange, 'id' | 'pullRequestNumber' | 'title'>
    >
    readonly sourceBranch: string
    readonly productionBranch: string
  },
): ReleaseBlockerDescription {
  const change = blocker.changeId ? input.changesById.get(blocker.changeId) : undefined
  const dependency = blocker.dependencyChangeId
    ? input.changesById.get(blocker.dependencyChangeId)
    : undefined
  const subject = change ? `#${change.pullRequestNumber} ${change.title}` : 'Repository'
  const dependencyReference = dependency
    ? `PR #${dependency.pullRequestNumber}`
    : blocker.dependencyChangeId
      ? `change ${blocker.dependencyChangeId}`
      : 'the dependency'

  switch (blocker.code) {
    case 'qa_pending':
      return { subject, message: 'QA has not passed' }
    case 'qa_failed':
      return { subject, message: 'QA failed' }
    case 'required_check_pending':
      return { subject, message: `${blocker.checkName ?? 'A required check'} is pending` }
    case 'required_check_failed':
      return { subject, message: `${blocker.checkName ?? 'A required check'} failed` }
    case 'required_check_missing':
      return { subject, message: `${blocker.checkName ?? 'A required check'} has no result` }
    case 'dependency_not_ready':
      return { subject, message: `Depends on blocked ${dependencyReference}` }
    case 'dependency_excluded':
      return { subject, message: `Depends on excluded ${dependencyReference}` }
    case 'dependency_unknown':
      return { subject, message: `Depends on unavailable ${dependencyReference}` }
    case 'dependency_cycle':
      return { subject, message: `Dependency cycle includes ${dependencyReference}` }
    case 'unmanaged_change':
      return {
        subject,
        message: blocker.commitSha
          ? `Unmanaged commit ${shortSha(blocker.commitSha)} exists between ${input.productionBranch} and ${input.sourceBranch}`
          : 'The change contains unmanaged commits',
      }
    case 'ambiguous_change':
      return {
        subject,
        message: blocker.commitSha
          ? `Commit ${shortSha(blocker.commitSha)} has ambiguous PR attribution`
          : 'The change has ambiguous commit attribution',
      }
    case 'partially_released_change':
      return { subject, message: 'Only part of the change is present in production' }
    case 'commit_set_unknown':
      return { subject, message: 'The current commit set cannot be trusted' }
    case 'source_changed':
      return { subject, message: `${input.sourceBranch} changed during evaluation` }
    case 'production_changed':
      return { subject, message: `${input.productionBranch} changed during evaluation` }
    case 'project_degraded':
      return { subject, message: 'Project synchronization is degraded' }
    case 'permission_missing':
      return { subject, message: 'Required GitHub access is unavailable' }
  }
}

function parseEvaluationChanges(value: unknown): readonly ReleaseEvaluationChange[] | null {
  if (!Array.isArray(value)) return null

  const result: ReleaseEvaluationChange[] = []

  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.changeId !== 'string' ||
      !isPositiveInteger(item.pullRequestNumber) ||
      typeof item.mergedAt !== 'string' ||
      Number.isNaN(Date.parse(item.mergedAt)) ||
      (item.status !== 'ready' && item.status !== 'blocked' && item.status !== 'excluded')
    ) {
      return null
    }

    const blockers = parseBlockers(item.blockers)
    if (blockers === null) return null

    result.push({
      changeId: item.changeId,
      pullRequestNumber: item.pullRequestNumber,
      mergedAt: item.mergedAt,
      status: item.status,
      blockers,
    })
  }

  return result
}

function parseBlockers(value: unknown): readonly ReleaseBlocker[] | null {
  if (!Array.isArray(value)) return null

  const result: ReleaseBlocker[] = []

  for (const item of value) {
    if (!isRecord(item) || typeof item.code !== 'string' || !isBlockerCode(item.code)) {
      return null
    }

    const changeId = parseNullableString(item.changeId)
    const dependencyChangeId = parseNullableString(item.dependencyChangeId)
    const checkName = parseNullableString(item.checkName)
    const commitSha = parseNullableString(item.commitSha)

    if (
      changeId === undefined ||
      dependencyChangeId === undefined ||
      checkName === undefined ||
      commitSha === undefined
    ) {
      return null
    }

    result.push({
      code: item.code,
      changeId,
      dependencyChangeId,
      checkName,
      commitSha,
    })
  }

  return result
}

function parseStringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

function parseNullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined
}

function isBlockerCode(value: string): value is ReleaseBlockerCode {
  return blockerCodes.has(value as ReleaseBlockerCode)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shortSha(value: string): string {
  return value.slice(0, 8)
}
