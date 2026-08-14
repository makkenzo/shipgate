export type ChangeId = string

export type ReleaseBlockerCode =
  | 'qa_pending'
  | 'qa_failed'
  | 'required_check_pending'
  | 'required_check_failed'
  | 'required_check_missing'
  | 'dependency_not_ready'
  | 'dependency_excluded'
  | 'dependency_unknown'
  | 'dependency_cycle'
  | 'unmanaged_change'
  | 'ambiguous_change'
  | 'partially_released_change'
  | 'commit_set_unknown'
  | 'source_changed'
  | 'production_changed'
  | 'project_degraded'
  | 'permission_missing'

export interface ReleaseEvaluationReference {
  readonly sourceSha: string
  readonly productionSha: string
  readonly configurationVersion: number
  readonly projectionVersion: number
}

export interface ReleaseEvaluationChangeInput {
  readonly id: ChangeId
  readonly pullRequestNumber: number
  readonly mergedAt: string
  readonly synchronizationState: 'valid' | 'stale' | 'unknown'
  readonly productionPresence: 'unreleased' | 'released' | 'partially_released' | 'unknown'
  readonly qaStatus: 'pending' | 'passed' | 'failed'
  readonly requiredChecks: readonly {
    readonly name: string
    readonly state: 'successful' | 'pending' | 'failed' | 'missing'
  }[]
  readonly commitAttribution: 'managed' | 'unmanaged' | 'ambiguous'
  readonly commitSetFingerprint: string | null
}

export interface ReleaseDependencyInput {
  readonly dependentChangeId: ChangeId
  readonly prerequisiteChangeId: ChangeId
}

export interface ReleaseEvaluationInput {
  readonly project: {
    readonly status:
      | 'initializing'
      | 'active'
      | 'degraded'
      | 'disconnected'
      | 'pending_deletion'
      | 'deleted'
    readonly permission: 'granted' | 'missing'
  }
  readonly candidateChangeIds: readonly ChangeId[]
  readonly excludedChangeIds: readonly ChangeId[]
  readonly changes: readonly ReleaseEvaluationChangeInput[]
  readonly dependencies: readonly ReleaseDependencyInput[]
  readonly unmanagedCommits?: readonly { readonly sha: string }[]
  readonly ambiguousCommits?: readonly { readonly sha: string }[]
  readonly expectedAgainst?: Pick<ReleaseEvaluationReference, 'sourceSha' | 'productionSha'>
  readonly evaluatedAgainst: ReleaseEvaluationReference
}

export interface ReleaseBlocker {
  readonly code: ReleaseBlockerCode
  readonly changeId: ChangeId | null
  readonly dependencyChangeId: ChangeId | null
  readonly checkName: string | null
  readonly commitSha: string | null
}

export interface EvaluatedChange {
  readonly changeId: ChangeId
  readonly pullRequestNumber: number
  readonly mergedAt: string
  readonly status: 'ready' | 'blocked' | 'excluded'
  readonly blockers: readonly ReleaseBlocker[]
}

export interface ReleaseEvaluation {
  readonly status: 'ready' | 'blocked'
  readonly includedChanges: readonly EvaluatedChange[]
  readonly excludedChanges: readonly EvaluatedChange[]
  readonly orderedChanges: readonly ChangeId[]
  readonly blockers: readonly ReleaseBlocker[]
  readonly evaluatedAgainst: ReleaseEvaluationReference
}

const blockerOrder: readonly ReleaseBlockerCode[] = [
  'project_degraded',
  'permission_missing',
  'source_changed',
  'production_changed',
  'unmanaged_change',
  'ambiguous_change',
  'commit_set_unknown',
  'partially_released_change',
  'qa_pending',
  'qa_failed',
  'required_check_missing',
  'required_check_pending',
  'required_check_failed',
  'dependency_unknown',
  'dependency_excluded',
  'dependency_cycle',
  'dependency_not_ready',
]

export function evaluateRelease(input: ReleaseEvaluationInput): ReleaseEvaluation {
  const changesById = buildChangeMap(input.changes)
  const candidateChangeIds = normalizeUniqueIds(input.candidateChangeIds, 'candidate change IDs')
  const excludedChangeIds = new Set(
    normalizeUniqueIds(input.excludedChangeIds, 'excluded change IDs'),
  )

  for (const changeId of candidateChangeIds) {
    if (!changesById.has(changeId)) {
      throw new TypeError(`Candidate change ${changeId} is missing from normalized changes`)
    }
  }

  for (const changeId of excludedChangeIds) {
    if (!candidateChangeIds.includes(changeId)) {
      throw new TypeError(`Excluded change ${changeId} is not part of the candidate`)
    }
  }

  const includedChangeIds = candidateChangeIds.filter(
    (changeId) => !excludedChangeIds.has(changeId),
  )
  const includedSet = new Set(includedChangeIds)
  const dependencies = normalizeDependencies(input.dependencies)
  const blockersByChange = new Map<ChangeId, ReleaseBlocker[]>()

  for (const changeId of candidateChangeIds) {
    const change = changesById.get(changeId)

    if (!change) {
      throw new Error(`Validated candidate change ${changeId} disappeared`)
    }

    blockersByChange.set(changeId, evaluateIntrinsicChange(change))
  }

  const cycleComponents = findDependencyComponents(includedChangeIds, dependencies)

  for (const component of cycleComponents) {
    if (!isCyclicComponent(component, dependencies)) {
      continue
    }

    const componentSet = new Set(component)

    for (const changeId of component) {
      const cycleDependency = dependencies
        .filter(
          (dependency) =>
            dependency.dependentChangeId === changeId &&
            componentSet.has(dependency.prerequisiteChangeId),
        )
        .map((dependency) => dependency.prerequisiteChangeId)
        .toSorted()[0]

      addBlocker(blockersByChange, changeId, {
        code: 'dependency_cycle',
        changeId,
        dependencyChangeId: cycleDependency ?? changeId,
        checkName: null,
        commitSha: null,
      })
    }
  }

  for (const dependency of dependencies) {
    if (!includedSet.has(dependency.dependentChangeId)) {
      continue
    }

    const target = changesById.get(dependency.prerequisiteChangeId)

    if (!target) {
      addBlocker(blockersByChange, dependency.dependentChangeId, {
        code: 'dependency_unknown',
        changeId: dependency.dependentChangeId,
        dependencyChangeId: dependency.prerequisiteChangeId,
        checkName: null,
        commitSha: null,
      })
      continue
    }

    if (target.productionPresence === 'released') {
      continue
    }

    if (excludedChangeIds.has(dependency.prerequisiteChangeId)) {
      addBlocker(blockersByChange, dependency.dependentChangeId, {
        code: 'dependency_excluded',
        changeId: dependency.dependentChangeId,
        dependencyChangeId: dependency.prerequisiteChangeId,
        checkName: null,
        commitSha: null,
      })
      continue
    }

    if (!includedSet.has(dependency.prerequisiteChangeId)) {
      addBlocker(blockersByChange, dependency.dependentChangeId, {
        code: 'dependency_unknown',
        changeId: dependency.dependentChangeId,
        dependencyChangeId: dependency.prerequisiteChangeId,
        checkName: null,
        commitSha: null,
      })
    }
  }

  const orderedChanges = orderIncludedChanges(includedChangeIds, dependencies, changesById)
  let propagated = true

  while (propagated) {
    propagated = false

    for (const dependentChangeId of orderedChanges) {
      for (const dependency of dependencies) {
        if (
          dependency.dependentChangeId !== dependentChangeId ||
          !includedSet.has(dependency.prerequisiteChangeId)
        ) {
          continue
        }

        const prerequisiteBlockers = blockersByChange.get(dependency.prerequisiteChangeId) ?? []

        if (prerequisiteBlockers.length === 0) {
          continue
        }

        const before = blockersByChange.get(dependentChangeId)?.length ?? 0
        addBlocker(blockersByChange, dependentChangeId, {
          code: 'dependency_not_ready',
          changeId: dependentChangeId,
          dependencyChangeId: dependency.prerequisiteChangeId,
          checkName: null,
          commitSha: null,
        })
        propagated ||= (blockersByChange.get(dependentChangeId)?.length ?? 0) > before
      }
    }
  }

  const globalBlockers = evaluateGlobalBlockers(input)
  const includedChanges = orderedChanges.map((changeId) =>
    toEvaluatedChange(changesById, blockersByChange, changeId, false),
  )
  const excludedChanges = [...excludedChangeIds]
    .toSorted((left, right) => compareChanges(changesById, left, right))
    .map((changeId) => toEvaluatedChange(changesById, blockersByChange, changeId, true))
  const changeBlockers = includedChanges.flatMap((change) => change.blockers)
  const blockers = sortBlockers([...globalBlockers, ...changeBlockers])

  return {
    status: blockers.length === 0 ? 'ready' : 'blocked',
    includedChanges,
    excludedChanges,
    orderedChanges,
    blockers,
    evaluatedAgainst: { ...input.evaluatedAgainst },
  }
}

function evaluateIntrinsicChange(change: ReleaseEvaluationChangeInput): ReleaseBlocker[] {
  const blockers: ReleaseBlocker[] = []
  const add = (code: ReleaseBlockerCode, options: { readonly checkName?: string } = {}): void => {
    const blocker: ReleaseBlocker = {
      code,
      changeId: change.id,
      dependencyChangeId: null,
      checkName: options.checkName ?? null,
      commitSha: null,
    }

    if (!blockers.some((candidate) => blockerKey(candidate) === blockerKey(blocker))) {
      blockers.push(blocker)
    }
  }

  if (change.synchronizationState !== 'valid' || change.commitSetFingerprint === null) {
    add('commit_set_unknown')
  }

  if (
    change.productionPresence === 'partially_released' ||
    change.productionPresence === 'released'
  ) {
    add('partially_released_change')
  } else if (change.productionPresence === 'unknown') {
    add('commit_set_unknown')
  }

  if (change.qaStatus === 'pending') {
    add('qa_pending')
  } else if (change.qaStatus === 'failed') {
    add('qa_failed')
  }

  for (const requiredCheck of [...change.requiredChecks].toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (requiredCheck.state === 'pending') {
      add('required_check_pending', { checkName: requiredCheck.name })
    } else if (requiredCheck.state === 'failed') {
      add('required_check_failed', { checkName: requiredCheck.name })
    } else if (requiredCheck.state === 'missing') {
      add('required_check_missing', { checkName: requiredCheck.name })
    }
  }

  if (change.commitAttribution === 'unmanaged') {
    add('unmanaged_change')
  } else if (change.commitAttribution === 'ambiguous') {
    add('ambiguous_change')
  }

  return sortBlockers(blockers)
}

function evaluateGlobalBlockers(input: ReleaseEvaluationInput): ReleaseBlocker[] {
  const blockers: ReleaseBlocker[] = []
  const add = (code: ReleaseBlockerCode, commitSha: string | null = null): void => {
    const blocker: ReleaseBlocker = {
      code,
      changeId: null,
      dependencyChangeId: null,
      checkName: null,
      commitSha,
    }

    if (!blockers.some((candidate) => blockerKey(candidate) === blockerKey(blocker))) {
      blockers.push(blocker)
    }
  }

  if (input.project.status !== 'active') {
    add('project_degraded')
  }

  if (input.project.permission === 'missing') {
    add('permission_missing')
  }

  if (
    input.expectedAgainst &&
    input.expectedAgainst.sourceSha !== input.evaluatedAgainst.sourceSha
  ) {
    add('source_changed')
  }

  if (
    input.expectedAgainst &&
    input.expectedAgainst.productionSha !== input.evaluatedAgainst.productionSha
  ) {
    add('production_changed')
  }

  for (const commit of [...(input.unmanagedCommits ?? [])].toSorted((left, right) =>
    left.sha.localeCompare(right.sha),
  )) {
    add('unmanaged_change', commit.sha)
  }

  for (const commit of [...(input.ambiguousCommits ?? [])].toSorted((left, right) =>
    left.sha.localeCompare(right.sha),
  )) {
    add('ambiguous_change', commit.sha)
  }

  return sortBlockers(blockers)
}

function buildChangeMap(
  changes: readonly ReleaseEvaluationChangeInput[],
): ReadonlyMap<ChangeId, ReleaseEvaluationChangeInput> {
  const result = new Map<ChangeId, ReleaseEvaluationChangeInput>()

  for (const change of changes) {
    if (result.has(change.id)) {
      throw new TypeError(`Normalized release input contains duplicate change ${change.id}`)
    }

    if (!Number.isSafeInteger(change.pullRequestNumber) || change.pullRequestNumber <= 0) {
      throw new TypeError(`Change ${change.id} has an invalid pull request number`)
    }

    if (Number.isNaN(Date.parse(change.mergedAt))) {
      throw new TypeError(`Change ${change.id} has an invalid merge timestamp`)
    }

    result.set(change.id, change)
  }

  return result
}

function normalizeUniqueIds(values: readonly string[], name: string): readonly string[] {
  const result: string[] = []
  const seen = new Set<string>()

  for (const value of values) {
    if (value.length === 0) {
      throw new TypeError(`${name} must not contain empty IDs`)
    }

    if (seen.has(value)) {
      throw new TypeError(`${name} contains duplicate ID ${value}`)
    }

    seen.add(value)
    result.push(value)
  }

  return result
}

function normalizeDependencies(
  dependencies: readonly ReleaseDependencyInput[],
): readonly ReleaseDependencyInput[] {
  const seen = new Set<string>()
  const result: ReleaseDependencyInput[] = []

  for (const dependency of dependencies) {
    const key = `${dependency.dependentChangeId}\u0000${dependency.prerequisiteChangeId}`

    if (!seen.has(key)) {
      seen.add(key)
      result.push(dependency)
    }
  }

  return result.toSorted(
    (left, right) =>
      left.dependentChangeId.localeCompare(right.dependentChangeId) ||
      left.prerequisiteChangeId.localeCompare(right.prerequisiteChangeId),
  )
}

function findDependencyComponents(
  includedChangeIds: readonly ChangeId[],
  dependencies: readonly ReleaseDependencyInput[],
): readonly (readonly ChangeId[])[] {
  const included = new Set(includedChangeIds)
  const adjacency = new Map<ChangeId, readonly ChangeId[]>()

  for (const changeId of includedChangeIds) {
    adjacency.set(
      changeId,
      dependencies
        .filter(
          (dependency) =>
            dependency.dependentChangeId === changeId &&
            included.has(dependency.prerequisiteChangeId),
        )
        .map((dependency) => dependency.prerequisiteChangeId)
        .toSorted(),
    )
  }

  let nextIndex = 0
  const indexes = new Map<ChangeId, number>()
  const lowLinks = new Map<ChangeId, number>()
  const stack: ChangeId[] = []
  const onStack = new Set<ChangeId>()
  const components: ChangeId[][] = []

  const visit = (changeId: ChangeId): void => {
    const index = nextIndex
    nextIndex += 1
    indexes.set(changeId, index)
    lowLinks.set(changeId, index)
    stack.push(changeId)
    onStack.add(changeId)

    for (const dependencyId of adjacency.get(changeId) ?? []) {
      if (!indexes.has(dependencyId)) {
        visit(dependencyId)
        lowLinks.set(
          changeId,
          Math.min(lowLinks.get(changeId) ?? index, lowLinks.get(dependencyId) ?? index),
        )
      } else if (onStack.has(dependencyId)) {
        lowLinks.set(
          changeId,
          Math.min(lowLinks.get(changeId) ?? index, indexes.get(dependencyId) ?? index),
        )
      }
    }

    if (lowLinks.get(changeId) !== indexes.get(changeId)) {
      return
    }

    const component: ChangeId[] = []

    while (stack.length > 0) {
      const member = stack.pop()

      if (!member) {
        break
      }

      onStack.delete(member)
      component.push(member)

      if (member === changeId) {
        break
      }
    }

    components.push(component.toSorted())
  }

  for (const changeId of [...includedChangeIds].toSorted()) {
    if (!indexes.has(changeId)) {
      visit(changeId)
    }
  }

  return components
}

function isCyclicComponent(
  component: readonly ChangeId[],
  dependencies: readonly ReleaseDependencyInput[],
): boolean {
  if (component.length > 1) {
    return true
  }

  const changeId = component[0]
  return dependencies.some(
    (dependency) =>
      dependency.dependentChangeId === changeId && dependency.prerequisiteChangeId === changeId,
  )
}

function orderIncludedChanges(
  includedChangeIds: readonly ChangeId[],
  dependencies: readonly ReleaseDependencyInput[],
  changesById: ReadonlyMap<ChangeId, ReleaseEvaluationChangeInput>,
): readonly ChangeId[] {
  const included = new Set(includedChangeIds)
  const components = findDependencyComponents(includedChangeIds, dependencies)
  const componentByChange = new Map<ChangeId, number>()

  components.forEach((component, index) => {
    for (const changeId of component) {
      componentByChange.set(changeId, index)
    }
  })

  const outgoing = new Map<number, Set<number>>()
  const indegree = new Map<number, number>(components.map((_, index) => [index, 0] as const))

  for (const dependency of dependencies) {
    if (
      !included.has(dependency.dependentChangeId) ||
      !included.has(dependency.prerequisiteChangeId)
    ) {
      continue
    }

    const dependentComponent = componentByChange.get(dependency.dependentChangeId)
    const prerequisiteComponent = componentByChange.get(dependency.prerequisiteChangeId)

    if (
      dependentComponent === undefined ||
      prerequisiteComponent === undefined ||
      dependentComponent === prerequisiteComponent
    ) {
      continue
    }

    const dependents = outgoing.get(prerequisiteComponent) ?? new Set<number>()

    if (!dependents.has(dependentComponent)) {
      dependents.add(dependentComponent)
      outgoing.set(prerequisiteComponent, dependents)
      indegree.set(dependentComponent, (indegree.get(dependentComponent) ?? 0) + 1)
    }
  }

  const compareComponents = (left: number, right: number): number => {
    const leftFirst = [...(components[left] ?? [])].toSorted((a, b) =>
      compareChanges(changesById, a, b),
    )[0]
    const rightFirst = [...(components[right] ?? [])].toSorted((a, b) =>
      compareChanges(changesById, a, b),
    )[0]

    if (!leftFirst || !rightFirst) {
      return left - right
    }

    return compareChanges(changesById, leftFirst, rightFirst)
  }
  const available = [...indegree.entries()]
    .filter(([, value]) => value === 0)
    .map(([component]) => component)
    .toSorted(compareComponents)
  const componentOrder: number[] = []

  while (available.length > 0) {
    const component = available.shift()

    if (component === undefined) {
      break
    }

    componentOrder.push(component)

    for (const dependent of [...(outgoing.get(component) ?? [])].toSorted(compareComponents)) {
      const next = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, next)

      if (next === 0) {
        available.push(dependent)
        available.sort(compareComponents)
      }
    }
  }

  if (componentOrder.length !== components.length) {
    const missing = components
      .map((_, index) => index)
      .filter((index) => !componentOrder.includes(index))
      .toSorted(compareComponents)
    componentOrder.push(...missing)
  }

  return componentOrder.flatMap((componentIndex) =>
    [...(components[componentIndex] ?? [])].toSorted((left, right) =>
      compareChanges(changesById, left, right),
    ),
  )
}

function compareChanges(
  changesById: ReadonlyMap<ChangeId, ReleaseEvaluationChangeInput>,
  leftId: ChangeId,
  rightId: ChangeId,
): number {
  const left = changesById.get(leftId)
  const right = changesById.get(rightId)

  if (!left || !right) {
    return leftId.localeCompare(rightId)
  }

  return (
    Date.parse(left.mergedAt) - Date.parse(right.mergedAt) ||
    left.pullRequestNumber - right.pullRequestNumber ||
    left.id.localeCompare(right.id)
  )
}

function addBlocker(
  blockersByChange: Map<ChangeId, ReleaseBlocker[]>,
  changeId: ChangeId,
  blocker: ReleaseBlocker,
): void {
  const blockers = blockersByChange.get(changeId) ?? []

  if (!blockers.some((candidate) => blockerKey(candidate) === blockerKey(blocker))) {
    blockers.push(blocker)
    blockersByChange.set(changeId, sortBlockers(blockers))
  }
}

function toEvaluatedChange(
  changesById: ReadonlyMap<ChangeId, ReleaseEvaluationChangeInput>,
  blockersByChange: ReadonlyMap<ChangeId, readonly ReleaseBlocker[]>,
  changeId: ChangeId,
  excluded: boolean,
): EvaluatedChange {
  const change = changesById.get(changeId)

  if (!change) {
    throw new Error(`Evaluated change ${changeId} is missing from normalized input`)
  }

  const blockers = sortBlockers([...(blockersByChange.get(changeId) ?? [])])

  return {
    changeId,
    pullRequestNumber: change.pullRequestNumber,
    mergedAt: change.mergedAt,
    status: excluded ? 'excluded' : blockers.length === 0 ? 'ready' : 'blocked',
    blockers,
  }
}

function sortBlockers(blockers: readonly ReleaseBlocker[]): ReleaseBlocker[] {
  return [...blockers].toSorted(
    (left, right) =>
      blockerOrder.indexOf(left.code) - blockerOrder.indexOf(right.code) ||
      (left.changeId ?? '').localeCompare(right.changeId ?? '') ||
      (left.dependencyChangeId ?? '').localeCompare(right.dependencyChangeId ?? '') ||
      (left.checkName ?? '').localeCompare(right.checkName ?? '') ||
      (left.commitSha ?? '').localeCompare(right.commitSha ?? ''),
  )
}

function blockerKey(blocker: ReleaseBlocker): string {
  return [
    blocker.code,
    blocker.changeId ?? '',
    blocker.dependencyChangeId ?? '',
    blocker.checkName ?? '',
    blocker.commitSha ?? '',
  ].join('\u0000')
}
