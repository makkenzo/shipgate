import { createCsrfHeaders } from './csrf'

export type ProjectStatus =
  | 'initializing'
  | 'active'
  | 'degraded'
  | 'disconnected'
  | 'pending_deletion'
  | 'deleted'

export type ProjectCheckState =
  | 'not_configured'
  | 'not_applicable'
  | 'successful'
  | 'pending'
  | 'failed'
  | 'missing'
  | 'stale'
  | 'unknown'

export type ProjectHealthState =
  | 'healthy'
  | 'attention'
  | 'initializing'
  | 'synchronizing'
  | 'degraded'
  | 'disconnected'
  | 'deleting'

export interface RequiredCheckOverride {
  readonly context: string
  readonly integrationId: number | null
}

export interface Project {
  readonly id: string
  readonly installationId: number
  readonly repositoryId: number
  readonly repository: {
    readonly ownerId: number
    readonly ownerLogin: string
    readonly name: string
    readonly fullName: string
    readonly defaultBranch: string | null
  }
  readonly sourceBranch: string
  readonly productionBranch: string
  readonly status: ProjectStatus
  readonly sourceSha: string | null
  readonly productionSha: string | null
  readonly lastSuccessfulSynchronization: string | null
  readonly configurationVersion: number
  readonly requiredCheckPolicyVersion: number
  readonly requiredCheckOverrides: readonly RequiredCheckOverride[]
  readonly deletionRequestedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ProjectHealth {
  readonly state: ProjectHealthState
  readonly summary: string
  readonly reasons: readonly {
    readonly severity: 'info' | 'warning' | 'error'
    readonly code: string
    readonly message: string
  }[]
}

export interface ProjectSynchronizationSummary {
  readonly id: string
  readonly status: 'queued' | 'running' | 'succeeded' | 'superseded' | 'failed'
  readonly reason: string
  readonly configurationVersion: number
  readonly classification:
    | 'expected_change'
    | 'recoverable_drift'
    | 'destructive_history_change'
    | 'permission_problem'
    | 'unknown_inconsistency'
    | null
  readonly sourceSha: string | null
  readonly productionSha: string | null
  readonly startedAt: string
  readonly completedAt: string | null
  readonly durationMs: number | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly differenceSummary: unknown
  readonly issueCount: number
}

export interface ProjectOverview {
  readonly project: Project
  readonly branches: {
    readonly source: ProjectOverviewBranch
    readonly production: ProjectOverviewBranch
  }
  readonly counts: {
    readonly unreleasedChanges: number
    readonly partiallyPresentChanges: number
    readonly unknownChanges: number
    readonly unmanagedCommits: number
    readonly ambiguousCommits: number
  }
  readonly requiredChecks: {
    readonly policyVersion: number
    readonly state: ProjectCheckState
    readonly checks: readonly {
      readonly id: string
      readonly context: string
      readonly integrationId: number | null
      readonly source: 'branch_protection' | 'repository_ruleset' | 'project_override'
      readonly sourceReference: string | null
      readonly state: ProjectCheckState
      readonly stateCounts: Readonly<
        Record<'pending' | 'successful' | 'failed' | 'missing' | 'stale', number>
      >
    }[]
  }
  readonly lastSynchronization: ProjectSynchronizationSummary | null
  readonly health: ProjectHealth
}

export interface ProjectOverviewBranch {
  readonly name: string
  readonly sha: string | null
  readonly protected: boolean | null
  readonly defaultBranch: boolean | null
  readonly observedAt: string | null
}

export type QaStatus = 'pending' | 'passed' | 'failed'

export interface ChangeQaState {
  readonly status: QaStatus
  readonly assessmentId: string | null
  readonly comment: string | null
  readonly actorGitHubUserId: number | null
  readonly assessedAt: string | null
}

export interface ProjectChangeQaMutationResult {
  readonly status: 'recorded' | 'already_applied'
  readonly qa: ChangeQaState
  readonly candidateReevaluation: {
    readonly candidateId: string
    readonly candidateVersion: number
  } | null
}

export interface ProjectChange {
  readonly id: string
  readonly githubPullRequestId: number
  readonly pullRequestNumber: number
  readonly title: string
  readonly url: string | null
  readonly authorId: number | null
  readonly authorLogin: string | null
  readonly mergedAt: string
  readonly mergeMethod: 'merge' | 'squash' | 'rebase' | 'unknown'
  readonly commitCount: number
  readonly commitSetFingerprint: string | null
  readonly synchronizationState: 'known' | 'unknown'
  readonly productionPresence: 'unreleased' | 'partially_present' | 'unknown'
  readonly checkState: ProjectCheckState
  readonly qa: ChangeQaState
  readonly finalHeadSha: string
  readonly commitShas: readonly string[]
  readonly requiredChecks: readonly {
    readonly requiredCheckId: string
    readonly policyVersion: number
    readonly context: string
    readonly integrationId: number | null
    readonly source: 'branch_protection' | 'repository_ruleset' | 'project_override'
    readonly sourceReference: string | null
    readonly commitSha: string
    readonly state: 'pending' | 'successful' | 'failed' | 'missing' | 'stale'
    readonly observations: readonly unknown[]
    readonly observedAt: string
  }[]
}

export type ReleaseCandidateStatus = 'evaluating' | 'ready' | 'blocked'

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

export interface ReleaseBlocker {
  readonly code: ReleaseBlockerCode
  readonly changeId: string | null
  readonly dependencyChangeId: string | null
  readonly checkName: string | null
  readonly commitSha: string | null
}

export interface ReleaseEvaluationChange {
  readonly changeId: string
  readonly pullRequestNumber: number
  readonly mergedAt: string
  readonly status: 'ready' | 'blocked' | 'excluded'
  readonly blockers: readonly ReleaseBlocker[]
}

export interface ReleaseEvaluationSummary {
  readonly status: 'ready' | 'blocked'
  readonly includedChanges: readonly ReleaseEvaluationChange[]
  readonly excludedChanges: readonly ReleaseEvaluationChange[]
  readonly orderedChanges: readonly string[]
  readonly blockers: readonly ReleaseBlocker[]
  readonly evaluatedAgainst: {
    readonly sourceSha: string
    readonly productionSha: string
    readonly configurationVersion: number
    readonly projectionVersion: number
  }
}

export interface ProjectReleaseCandidate {
  readonly id: string
  readonly sequence: number
  readonly version: number
  readonly status: ReleaseCandidateStatus
  readonly createdByGitHubUserId: number | null
  readonly latestEvaluationVersion: number | null
  readonly latestEvaluation: {
    readonly id: string
    readonly version: number
    readonly result: 'ready' | 'blocked'
    readonly summary: unknown
    readonly blockers: unknown
    readonly evaluatedAt: string
    readonly projectStateVersion: number
    readonly projectionVersion: number
  } | null
  readonly pendingEvaluation: {
    readonly requestId: string
    readonly status: 'queued' | 'running'
    readonly reasons: readonly string[]
    readonly coalescedCount: number
    readonly requestedAt: string
    readonly claimedAt: string | null
  } | null
  readonly exclusions: readonly {
    readonly changeId: string
    readonly pullRequestNumber: number | null
    readonly title: string | null
    readonly actorGitHubUserId: number
    readonly reason: string | null
    readonly candidateVersion: number
    readonly excludedAt: string
    readonly updatedAt: string
  }[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ProjectChangeDependency {
  readonly changeId: string
  readonly pullRequestNumber: number
  readonly source: 'user' | 'managed_pr_body' | 'system'
  readonly actorGitHubUserId: number | null
  readonly version: number
  readonly updatedAt: string
}

export interface ProjectChangeDependencyMutationResult {
  readonly status: 'recorded' | 'already_applied'
  readonly dependentChangeId: string
  readonly dependentPullRequestNumber: number
  readonly dependencies: readonly ProjectChangeDependency[]
  readonly candidateReevaluation: {
    readonly candidateId: string
    readonly candidateVersion: number
  } | null
  readonly githubBodyUpdated: boolean
}

export interface CandidateExclusionMutationResult {
  readonly status: 'recorded' | 'already_applied'
  readonly candidateId: string
  readonly candidateVersion: number
  readonly changeId: string
  readonly excluded: boolean
  readonly evaluationRequestId: string | null
}

export interface ProjectSynchronizationRun extends ProjectSynchronizationSummary {
  readonly requestedAt: string
  readonly coalescedCount: number
  readonly forcePush: boolean
  readonly triggerScope: unknown
  readonly issues: readonly {
    readonly id: string
    readonly severity: 'warning' | 'error'
    readonly code: string
    readonly scope: 'repository' | 'branch' | 'change' | 'commit' | 'check'
    readonly subjectId: string | null
    readonly message: string
    readonly details: unknown
    readonly createdAt: string
  }[]
}

export interface ProjectSynchronizationHistory {
  readonly project: Project
  readonly health: ProjectHealth
  readonly runs: readonly ProjectSynchronizationRun[]
}

export interface Reconciliation {
  readonly requestId: string
  readonly status: 'queued' | 'running' | 'succeeded' | 'superseded' | 'failed' | 'cancelled'
  readonly configurationVersion: number
  readonly reason: string
  readonly mode: 'full'
  readonly sourceSha: string
  readonly productionSha: string
  readonly requestedAt: string
}

export interface ProjectMutationResult {
  readonly status: 'created' | 'updated' | 'already_applied'
  readonly project: Project
  readonly reconciliation: Reconciliation | null
}

export class ProjectApiError extends Error {
  readonly code: string
  readonly requestId: string | undefined
  readonly details: unknown

  constructor(input: {
    readonly code: string
    readonly message: string
    readonly requestId?: string
    readonly details?: unknown
  }) {
    super(input.message)
    this.name = 'ProjectApiError'
    this.code = input.code
    this.requestId = input.requestId
    this.details = input.details
  }
}

export async function getProjects(): Promise<readonly Project[]> {
  const result = await requestJson<{ readonly projects: readonly Project[] }>('/api/v1/projects')
  return result.projects
}

export function getProjectOverview(projectId: string): Promise<ProjectOverview> {
  return requestJson(`/api/v1/projects/${encodeURIComponent(projectId)}/overview`)
}

export async function getProjectChanges(projectId: string): Promise<readonly ProjectChange[]> {
  const result = await requestJson<{ readonly changes: readonly ProjectChange[] }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/changes`,
  )
  return result.changes
}

export function setProjectChangeQa(
  projectId: string,
  changeId: string,
  input: {
    readonly status: QaStatus
    readonly comment?: string
  },
): Promise<ProjectChangeQaMutationResult> {
  return requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/changes/${encodeURIComponent(changeId)}/qa`,
    {
      method: 'PUT',
      headers: mutationHeaders(),
      body: JSON.stringify(input),
    },
  )
}

export async function getProjectReleaseCandidate(
  projectId: string,
): Promise<ProjectReleaseCandidate | null> {
  const result = await requestJson<{ readonly candidate: ProjectReleaseCandidate | null }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/release-candidate`,
  )
  return result.candidate
}

export async function getProjectChangeDependencies(
  projectId: string,
  changeId: string,
): Promise<readonly ProjectChangeDependency[]> {
  const result = await requestJson<{ readonly dependencies: readonly ProjectChangeDependency[] }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/changes/${encodeURIComponent(changeId)}/dependencies`,
  )
  return result.dependencies
}

export function setProjectChangeDependencies(
  projectId: string,
  changeId: string,
  dependencyChangeIds: readonly string[],
): Promise<ProjectChangeDependencyMutationResult> {
  return requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/changes/${encodeURIComponent(changeId)}/dependencies`,
    {
      method: 'PUT',
      headers: mutationHeaders(),
      body: JSON.stringify({ dependencyChangeIds }),
    },
  )
}

export function excludeProjectChangeFromCandidate(
  projectId: string,
  changeId: string,
  reason?: string,
): Promise<CandidateExclusionMutationResult> {
  return requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/changes/${encodeURIComponent(changeId)}/exclusion`,
    {
      method: 'PUT',
      headers: mutationHeaders(),
      body: JSON.stringify(reason === undefined ? {} : { reason }),
    },
  )
}

export function restoreProjectChangeToCandidate(
  projectId: string,
  changeId: string,
): Promise<CandidateExclusionMutationResult> {
  return requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/changes/${encodeURIComponent(changeId)}/exclusion`,
    {
      method: 'DELETE',
      headers: createCsrfHeaders(),
    },
  )
}

export function getProjectSynchronization(
  projectId: string,
  limit = 30,
): Promise<ProjectSynchronizationHistory> {
  const query = new URLSearchParams({ limit: String(limit) })
  return requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/synchronization?${query.toString()}`,
  )
}

export function createProject(input: {
  readonly installationId: number
  readonly repositoryId: number
  readonly sourceBranch: string
  readonly productionBranch: string
  readonly requiredCheckOverrides?: readonly RequiredCheckOverride[]
}): Promise<ProjectMutationResult> {
  return requestJson('/api/v1/projects', {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify(input),
  })
}

export function updateProject(
  projectId: string,
  input: {
    readonly expectedConfigurationVersion: number
    readonly sourceBranch?: string
    readonly productionBranch?: string
    readonly requiredCheckOverrides?: readonly RequiredCheckOverride[]
  },
): Promise<ProjectMutationResult> {
  return requestJson(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    headers: mutationHeaders(),
    body: JSON.stringify(input),
  })
}

export async function reconcileProject(
  projectId: string,
  expectedConfigurationVersion: number,
): Promise<Reconciliation> {
  const result = await requestJson<{ readonly reconciliation: Reconciliation }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/reconciliation`,
    {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({ expectedConfigurationVersion }),
    },
  )
  return result.reconciliation
}

export async function deleteProject(
  projectId: string,
  expectedConfigurationVersion: number,
): Promise<Project> {
  const query = new URLSearchParams({
    expectedConfigurationVersion: String(expectedConfigurationVersion),
  })
  const result = await requestJson<{ readonly project: Project }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}?${query.toString()}`,
    {
      method: 'DELETE',
      headers: createCsrfHeaders(),
    },
  )
  return result.project
}

async function requestJson<Result>(path: string, init?: RequestInit): Promise<Result> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
  })
  const payload = await readJson(response)

  if (!response.ok) {
    throw toProjectApiError(payload, response)
  }

  return payload as Result
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')

  if (!contentType?.includes('application/json')) {
    return undefined
  }

  return response.json()
}

function toProjectApiError(payload: unknown, response: Response): ProjectApiError {
  if (isRecord(payload)) {
    return new ProjectApiError({
      code: typeof payload.code === 'string' ? payload.code : 'PROJECT_REQUEST_FAILED',
      message:
        typeof payload.message === 'string'
          ? payload.message
          : `Shipgate API returned HTTP ${response.status}`,
      ...(typeof payload.requestId === 'string' ? { requestId: payload.requestId } : {}),
      ...('details' in payload ? { details: payload.details } : {}),
    })
  }

  return new ProjectApiError({
    code: 'INVALID_API_RESPONSE',
    message: `Shipgate API returned HTTP ${response.status}`,
    requestId: response.headers.get('x-request-id') ?? undefined,
  })
}

function mutationHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...createCsrfHeaders(),
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
