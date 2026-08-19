import { queryOptions } from '@tanstack/react-query'

import {
  getProjectChangeDependencies,
  getProjectChanges,
  getProjectOverview,
  getProjectReleaseCandidate,
  getProjectSynchronization,
  getProjects,
} from './projects'

export const projectKeys = {
  all: ['projects'] as const,
  list: () => [...projectKeys.all, 'list'] as const,
  overview: (projectId: string) => [...projectKeys.all, projectId, 'overview'] as const,
  changes: (projectId: string) => [...projectKeys.all, projectId, 'changes'] as const,
  releaseCandidate: (projectId: string) =>
    [...projectKeys.all, projectId, 'release-candidate'] as const,
  dependencies: (projectId: string, changeId: string) =>
    [...projectKeys.all, projectId, 'changes', changeId, 'dependencies'] as const,
  synchronization: (projectId: string) =>
    [...projectKeys.all, projectId, 'synchronization'] as const,
}

export const projectsOptions = () =>
  queryOptions({
    queryKey: projectKeys.list(),
    queryFn: getProjects,
    staleTime: 15_000,
    refetchInterval: 30_000,
  })

export const projectOverviewOptions = (projectId: string) =>
  queryOptions({
    queryKey: projectKeys.overview(projectId),
    queryFn: () => getProjectOverview(projectId),
    staleTime: 10_000,
    refetchInterval: 15_000,
  })

export const projectChangesOptions = (projectId: string) =>
  queryOptions({
    queryKey: projectKeys.changes(projectId),
    queryFn: () => getProjectChanges(projectId),
    staleTime: 10_000,
    refetchInterval: 15_000,
  })

export const projectReleaseCandidateOptions = (projectId: string) =>
  queryOptions({
    queryKey: projectKeys.releaseCandidate(projectId),
    queryFn: () => getProjectReleaseCandidate(projectId),
    staleTime: 2_000,
    refetchInterval: (query) => (query.state.data?.status === 'evaluating' ? 1_500 : 10_000),
  })

export const projectChangeDependenciesOptions = (projectId: string, changeId: string) =>
  queryOptions({
    queryKey: projectKeys.dependencies(projectId, changeId),
    queryFn: () => getProjectChangeDependencies(projectId, changeId),
    staleTime: 10_000,
  })

export const projectSynchronizationOptions = (projectId: string) =>
  queryOptions({
    queryKey: projectKeys.synchronization(projectId),
    queryFn: () => getProjectSynchronization(projectId),
    staleTime: 5_000,
    refetchInterval: 10_000,
  })
