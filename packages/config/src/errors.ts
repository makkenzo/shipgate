import type { ZodError } from 'zod'

export type EnvironmentScope = 'runtime' | 'secrets'

export interface EnvironmentValidationIssue {
  readonly path: string
  readonly code: string
  readonly message: string
}

export class EnvironmentValidationError extends Error {
  readonly scope: EnvironmentScope
  readonly issues: readonly EnvironmentValidationIssue[]

  constructor(scope: EnvironmentScope, error: ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '<root>',
      code: issue.code,
      message: issue.message,
    }))

    super(`Invalid ${scope} environment: ${issues.map((issue) => issue.path).join(', ')}`)

    this.name = 'EnvironmentValidationError'
    this.scope = scope
    this.issues = issues
  }
}
