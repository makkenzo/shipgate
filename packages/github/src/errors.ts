export class GitHubAuthenticationError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, {
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })

    this.name = 'GitHubAuthenticationError'
  }
}

export class GitHubInstallationScopeError extends GitHubAuthenticationError {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubInstallationScopeError'
  }
}

export class GitHubUserAuthorizationNotFoundError extends GitHubAuthenticationError {
  readonly userId: number

  constructor(userId: number) {
    super(`No GitHub user authorization is stored for user ${userId}`)
    this.name = 'GitHubUserAuthorizationNotFoundError'
    this.userId = userId
  }
}

export class GitHubUserReauthorizationRequiredError extends GitHubAuthenticationError {
  readonly userId: number

  constructor(userId: number, message = 'GitHub user authorization must be renewed') {
    super(`${message} for user ${userId}`)
    this.name = 'GitHubUserReauthorizationRequiredError'
    this.userId = userId
  }
}

export class GitHubUserTokenRotationError extends GitHubAuthenticationError {
  readonly userId: number

  constructor(userId: number, message: string, options: { readonly cause?: unknown } = {}) {
    super(`${message} for GitHub user ${userId}`, options)
    this.name = 'GitHubUserTokenRotationError'
    this.userId = userId
  }
}
