import type { InstallationPermissionLevel, InstallationPermissionName } from '@shipgate/github'

import type { GitHubInstallationSummary } from '../auth/model.js'

export type GitHubRepositoryPermission = 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin'

export interface RequiredRepositoryPermission {
  readonly repository: Exclude<GitHubRepositoryPermission, 'none'>
  readonly app?: {
    readonly name: InstallationPermissionName
    readonly level: InstallationPermissionLevel
  }
}

export type RepositoryAccessDenialReason =
  | 'installation_not_accessible'
  | 'installation_revoked'
  | 'installation_suspended'
  | 'repository_not_selected'
  | 'repository_not_accessible'
  | 'insufficient_repository_permission'
  | 'insufficient_app_permission'

export interface RepositoryAccessDecision {
  readonly allowed: boolean
  readonly reason: 'allowed' | RepositoryAccessDenialReason
  readonly githubUserId: number
  readonly installationId: number
  readonly repositoryId: number
  readonly repositoryPermission: GitHubRepositoryPermission
  readonly requiredPermission: RequiredRepositoryPermission
  readonly verifiedAt: Date
  readonly cacheExpiresAt: Date
}

export interface GitHubInstallationMetadata {
  readonly summary: GitHubInstallationSummary
  readonly permissions: Readonly<Record<string, string>>
}

export interface GitHubInstallationRepository {
  readonly id: number
  readonly ownerId: number
  readonly ownerLogin: string
  readonly name: string
  readonly fullName: string
  readonly private: boolean
  readonly archived: boolean
  readonly disabled: boolean
  readonly defaultBranch: string | null
  readonly visibility: string | null
}

export interface GitHubUserRepositoryAccess {
  readonly repository: GitHubInstallationRepository
  readonly permission: GitHubRepositoryPermission
}

export interface ReconciledInstallationAccess {
  readonly installation: GitHubInstallationMetadata
  readonly repositories: readonly GitHubInstallationRepository[]
  readonly userRepositories: readonly GitHubUserRepositoryAccess[]
  readonly reconciledAt: Date
}
