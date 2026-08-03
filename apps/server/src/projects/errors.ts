export class ProjectNotFoundError extends Error {
  readonly projectId: string

  constructor(projectId: string) {
    super(`Project ${projectId} was not found`)
    this.name = 'ProjectNotFoundError'
    this.projectId = projectId
  }
}

export class ProjectVersionConflictError extends Error {
  readonly projectId: string
  readonly expectedVersion: number
  readonly actualVersion: number

  constructor(projectId: string, expectedVersion: number, actualVersion: number) {
    super(
      [
        `Project ${projectId} configuration version conflict:`,
        `expected ${expectedVersion}, actual ${actualVersion}`,
      ].join(' '),
    )
    this.name = 'ProjectVersionConflictError'
    this.projectId = projectId
    this.expectedVersion = expectedVersion
    this.actualVersion = actualVersion
  }
}

export class RepositoryAlreadyConnectedError extends Error {
  readonly repositoryId: string
  readonly projectId: string

  constructor(repositoryId: string, projectId: string) {
    super(`GitHub repository ${repositoryId} is already connected to project ${projectId}`)
    this.name = 'RepositoryAlreadyConnectedError'
    this.repositoryId = repositoryId
    this.projectId = projectId
  }
}

export class ProjectRepositoryUnavailableError extends Error {
  readonly installationId: string
  readonly repositoryId: string

  constructor(installationId: string, repositoryId: string, reason: string) {
    super(
      [
        `GitHub repository ${repositoryId} is unavailable for installation ${installationId}:`,
        reason,
      ].join(' '),
    )
    this.name = 'ProjectRepositoryUnavailableError'
    this.installationId = installationId
    this.repositoryId = repositoryId
  }
}

export class RepositoryProjectionInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryProjectionInvariantError'
  }
}

export class RepositoryProjectionIdempotencyConflictError extends Error {
  readonly projectId: string
  readonly idempotencyKey: string

  constructor(projectId: string, idempotencyKey: string) {
    super(
      [
        `Repository synchronization ${idempotencyKey} for project ${projectId}`,
        'already exists with different input',
      ].join(' '),
    )
    this.name = 'RepositoryProjectionIdempotencyConflictError'
    this.projectId = projectId
    this.idempotencyKey = idempotencyKey
  }
}
