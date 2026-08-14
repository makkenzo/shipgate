export interface ChangeDependencyEdge {
  readonly dependentChangeId: string
  readonly prerequisiteChangeId: string
}

export class DependencyCycleError extends Error {
  readonly cycle: readonly string[]

  constructor(cycle: readonly string[]) {
    super(`Dependency graph contains a cycle: ${cycle.join(' -> ')}`)
    this.name = 'DependencyCycleError'
    this.cycle = cycle
  }
}

export function assertAcyclicDependencyGraph(edges: readonly ChangeDependencyEdge[]): void {
  const cycle = findDependencyCycle(edges)

  if (cycle) {
    throw new DependencyCycleError(cycle)
  }
}

export function findDependencyCycle(
  edges: readonly ChangeDependencyEdge[],
): readonly string[] | null {
  const adjacency = new Map<string, Set<string>>()
  const nodes = new Set<string>()

  for (const edge of edges) {
    nodes.add(edge.dependentChangeId)
    nodes.add(edge.prerequisiteChangeId)

    const dependencies = adjacency.get(edge.dependentChangeId) ?? new Set<string>()
    dependencies.add(edge.prerequisiteChangeId)
    adjacency.set(edge.dependentChangeId, dependencies)
  }

  const state = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []
  const stackIndexes = new Map<string, number>()

  const visit = (changeId: string): readonly string[] | null => {
    const currentState = state.get(changeId)

    if (currentState === 'visited') {
      return null
    }

    if (currentState === 'visiting') {
      const cycleStart = stackIndexes.get(changeId)

      if (cycleStart === undefined) {
        throw new Error('Dependency DFS stack is inconsistent')
      }

      return [...stack.slice(cycleStart), changeId]
    }

    state.set(changeId, 'visiting')
    stackIndexes.set(changeId, stack.length)
    stack.push(changeId)

    const dependencies = [...(adjacency.get(changeId) ?? [])].toSorted()

    for (const dependencyId of dependencies) {
      const cycle = visit(dependencyId)

      if (cycle) {
        return cycle
      }
    }

    stack.pop()
    stackIndexes.delete(changeId)
    state.set(changeId, 'visited')
    return null
  }

  for (const changeId of [...nodes].toSorted()) {
    const cycle = visit(changeId)

    if (cycle) {
      return cycle
    }
  }

  return null
}
