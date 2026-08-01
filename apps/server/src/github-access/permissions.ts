import {
  GITHUB_APP_REPOSITORY_PERMISSIONS,
  type InstallationPermissionLevel,
} from '@shipgate/github'

import type { CachedRepositoryAccess } from './cache.js'
import type {
  GitHubRepositoryPermission,
  RepositoryAccessDecision,
  RepositoryAccessDenialReason,
  RequiredRepositoryPermission,
} from './model.js'

export function createRepositoryAccessDecision(
  cached: CachedRepositoryAccess,
  requiredPermission: RequiredRepositoryPermission,
): RepositoryAccessDecision {
  const denialReason = getDenialReason(cached, requiredPermission)

  return {
    allowed: denialReason === undefined,
    reason: denialReason ?? 'allowed',
    githubUserId: cached.githubUserId,
    installationId: cached.installationId,
    repositoryId: cached.repositoryId,
    repositoryPermission: cached.repositoryPermission,
    requiredPermission,
    verifiedAt: new Date(cached.verifiedAt),
    cacheExpiresAt: new Date(cached.expiresAt),
  }
}

export function createInaccessibleRepositoryAccessDecision(input: {
  readonly githubUserId: number
  readonly installationId: number
  readonly repositoryId: number
  readonly requiredPermission: RequiredRepositoryPermission
  readonly reason: Extract<
    RepositoryAccessDenialReason,
    'installation_not_accessible' | 'installation_revoked'
  >
  readonly verifiedAt: Date
  readonly cacheExpiresAt: Date
}): RepositoryAccessDecision {
  return {
    allowed: false,
    reason: input.reason,
    githubUserId: input.githubUserId,
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    repositoryPermission: 'none',
    requiredPermission: input.requiredPermission,
    verifiedAt: new Date(input.verifiedAt),
    cacheExpiresAt: new Date(input.cacheExpiresAt),
  }
}

export function assertRequiredRepositoryPermission(value: RequiredRepositoryPermission): void {
  const repository = value.repository as GitHubRepositoryPermission

  if (!Object.hasOwn(repositoryPermissionRank, repository) || repository === 'none') {
    throw new TypeError('requiredPermission.repository is invalid')
  }

  if (value.app && !Object.hasOwn(GITHUB_APP_REPOSITORY_PERMISSIONS, value.app.name)) {
    throw new TypeError('requiredPermission.app.name is not granted by the Shipgate GitHub App')
  }

  if (value.app && value.app.level !== 'read' && value.app.level !== 'write') {
    throw new TypeError('requiredPermission.app.level must be read or write')
  }
}

export function assertPositiveGitHubId(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
}

function getDenialReason(
  cached: CachedRepositoryAccess,
  requirement: RequiredRepositoryPermission,
): RepositoryAccessDenialReason | undefined {
  if (cached.installationState === 'revoked') {
    return 'installation_revoked'
  }

  if (cached.installationState === 'inaccessible') {
    return 'installation_not_accessible'
  }

  if (cached.installationState === 'suspended') {
    return 'installation_suspended'
  }

  if (!cached.repositorySelected) {
    return 'repository_not_selected'
  }

  if (cached.repositoryPermission === 'none') {
    return 'repository_not_accessible'
  }

  if (requirement.app && !hasAppPermission(cached.appPermissions, requirement.app)) {
    return 'insufficient_app_permission'
  }

  if (
    repositoryPermissionRank[cached.repositoryPermission] <
    repositoryPermissionRank[requirement.repository]
  ) {
    return 'insufficient_repository_permission'
  }

  return undefined
}

function hasAppPermission(
  permissions: Readonly<Record<string, string>>,
  required: {
    readonly name: string
    readonly level: InstallationPermissionLevel
  },
): boolean {
  const actual = permissions[required.name]

  if (required.level === 'read') {
    return actual === 'read' || actual === 'write'
  }

  return actual === 'write'
}

const repositoryPermissionRank: Readonly<Record<GitHubRepositoryPermission, number>> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
}
