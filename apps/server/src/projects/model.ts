import type {
  ChangeMergeMethod,
  ChangeProductionPresence,
  ChangeSynchronizationState,
  CommitCheckConclusion,
  CommitCheckStatus,
  JsonValue,
  ProjectStatus,
  RepositorySyncIssueScope,
  RepositorySyncIssueSeverity,
  RequiredCheckSource,
  RequiredCheckType,
} from '@shipgate/database'

export type GitHubNumericId = number | string

export interface ProjectRecord {
  readonly id: string
  readonly installationId: string
  readonly repositoryId: string
  readonly ownerId: string
  readonly ownerLogin: string
  readonly repositoryName: string
  readonly repositoryFullName: string
  readonly defaultBranch: string | null
  readonly sourceBranch: string
  readonly productionBranch: string
  readonly status: ProjectStatus
  readonly sourceSha: string | null
  readonly productionSha: string | null
  readonly lastSuccessfulSyncAt: Date | null
  readonly configurationVersion: number
  readonly deletionRequestedAt: Date | null
  readonly deletedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface ReconciliationRequestRecord {
  readonly id: string
  readonly syncRunId: string
  readonly projectId: string
  readonly repositoryId: string
  readonly configurationVersion: number
  readonly reason: string
  readonly mode: 'full'
  readonly status: 'queued' | 'running' | 'succeeded' | 'superseded' | 'failed' | 'cancelled'
  readonly sourceSha: string
  readonly productionSha: string
  readonly requestedAt: Date
}

export interface CreateProjectInput {
  readonly projectId?: string
  readonly installationId: GitHubNumericId
  readonly repositoryId: GitHubNumericId
  readonly sourceBranch: string
  readonly productionBranch: string
  readonly now?: Date
}

export interface RepositoryBranchProjection {
  readonly name: string
  readonly headSha: string
  readonly protected: boolean
  readonly defaultBranch: boolean
}

export interface RepositoryCommitProjection {
  readonly sha: string
  readonly treeSha: string | null
  readonly message: string
  readonly authorId: GitHubNumericId | null
  readonly authorLogin: string | null
  readonly authorName: string | null
  readonly authorEmail: string | null
  readonly committerId: GitHubNumericId | null
  readonly committerLogin: string | null
  readonly authoredAt: Date | null
  readonly committedAt: Date
  readonly parentShas: readonly string[]
  readonly sourceDeltaPosition: number | null
}

export interface ChangeProjection {
  readonly id?: string
  readonly githubPullRequestId: GitHubNumericId
  readonly pullRequestNumber: number
  readonly title: string
  readonly url: string | null
  readonly authorId: GitHubNumericId | null
  readonly authorLogin: string | null
  readonly baseBranch: string
  readonly mergedAt: Date
  readonly finalHeadSha: string
  readonly mergeCommitSha: string | null
  readonly sourceIntegrationSha: string | null
  readonly mergeMethod: ChangeMergeMethod
  readonly commitSetFingerprint: string | null
  readonly synchronizationState: ChangeSynchronizationState
  readonly productionPresence: ChangeProductionPresence
  readonly commitShas: readonly string[]
}

export interface RequiredCheckProjection {
  readonly id?: string
  readonly policyVersion: number
  readonly type: RequiredCheckType
  readonly context: string
  readonly integrationId: GitHubNumericId | null
  readonly source: RequiredCheckSource
  readonly sourceReference: string | null
}

export interface CommitCheckResultProjection {
  readonly id?: string
  readonly commitSha: string
  readonly type: RequiredCheckType
  readonly context: string
  readonly integrationId: GitHubNumericId | null
  readonly githubObjectId: GitHubNumericId
  readonly attempt: number | null
  readonly status: CommitCheckStatus
  readonly conclusion: CommitCheckConclusion | null
  readonly detailsUrl: string | null
  readonly startedAt: Date | null
  readonly completedAt: Date | null
  readonly observedAt: Date
}

export interface RepositorySyncIssueProjection {
  readonly id?: string
  readonly severity: RepositorySyncIssueSeverity
  readonly code: string
  readonly scope: RepositorySyncIssueScope
  readonly subjectId: string | null
  readonly message: string
  readonly details?: JsonValue
}

export interface RepositoryProjectionSnapshot {
  readonly installationId: GitHubNumericId
  readonly ownerId: GitHubNumericId
  readonly ownerLogin: string
  readonly repositoryName: string
  readonly repositoryFullName: string
  readonly defaultBranch: string | null
  readonly sourceSha: string
  readonly productionSha: string
  readonly observedAt: Date
  readonly branches: readonly RepositoryBranchProjection[]
  readonly commits: readonly RepositoryCommitProjection[]
  readonly changes: readonly ChangeProjection[]
  readonly requiredChecks: readonly RequiredCheckProjection[]
  readonly checkResults: readonly CommitCheckResultProjection[]
  readonly issues: readonly RepositorySyncIssueProjection[]
}

export interface ApplyRepositoryProjectionInput {
  readonly projectId: string
  readonly syncRunId?: string
  readonly repositoryId: GitHubNumericId
  readonly expectedConfigurationVersion: number
  readonly reason: string
  readonly idempotencyKey: string
  readonly projectionFingerprint: string
  readonly startedAt: Date
  readonly completedAt: Date
  readonly snapshot: RepositoryProjectionSnapshot
}

export type ApplyRepositoryProjectionResult =
  | {
      readonly status: 'applied'
      readonly syncRunId: string
      readonly project: ProjectRecord
    }
  | {
      readonly status: 'already_applied'
      readonly syncRunId: string
      readonly project: ProjectRecord
    }

export interface RecordRepositorySyncFailureInput {
  readonly projectId: string
  readonly repositoryId: GitHubNumericId
  readonly expectedConfigurationVersion: number
  readonly reason: string
  readonly idempotencyKey: string
  readonly startedAt: Date
  readonly completedAt: Date
  readonly errorCode: string
  readonly errorMessage?: string
  readonly sourceSha?: string
  readonly productionSha?: string
  readonly issues: readonly RepositorySyncIssueProjection[]
  readonly disconnectProject?: boolean
}

export type RecordRepositorySyncFailureResult =
  | {
      readonly status: 'recorded'
      readonly syncRunId: string
    }
  | {
      readonly status: 'already_recorded'
      readonly syncRunId: string
    }

export interface ChangeAheadOfProduction {
  readonly id: string
  readonly githubPullRequestId: string
  readonly pullRequestNumber: number
  readonly title: string
  readonly authorId: string | null
  readonly authorLogin: string | null
  readonly mergedAt: Date
  readonly mergeMethod: Exclude<ChangeMergeMethod, 'unknown'>
  readonly commitSetFingerprint: string
  readonly productionPresence: Extract<ChangeProductionPresence, 'missing' | 'not_applicable'>
  readonly commitShas: readonly string[]
}

export interface UnmanagedCommitRecord {
  readonly sha: string
  readonly message: string
  readonly authorId: string | null
  readonly authorLogin: string | null
  readonly committedAt: Date
  readonly sourceDeltaPosition: number
}
