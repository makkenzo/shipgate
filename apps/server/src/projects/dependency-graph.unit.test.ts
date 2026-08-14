import { describe, expect, it } from 'vitest'

import {
  assertAcyclicDependencyGraph,
  DependencyCycleError,
  findDependencyCycle,
} from './dependency-graph.js'

describe('dependency graph', () => {
  it('accepts a DAG independently of input order', () => {
    const edges = [
      { dependentChangeId: 'C', prerequisiteChangeId: 'B' },
      { dependentChangeId: 'B', prerequisiteChangeId: 'A' },
    ]

    expect(findDependencyCycle(edges)).toBeNull()
    expect(() => assertAcyclicDependencyGraph([...edges].reverse())).not.toThrow()
  })

  it('returns a stable cycle path', () => {
    const edges = [
      { dependentChangeId: 'C', prerequisiteChangeId: 'A' },
      { dependentChangeId: 'A', prerequisiteChangeId: 'B' },
      { dependentChangeId: 'B', prerequisiteChangeId: 'C' },
    ]

    expect(findDependencyCycle(edges)).toEqual(['A', 'B', 'C', 'A'])
    expect(() => assertAcyclicDependencyGraph(edges)).toThrow(DependencyCycleError)
  })
})
