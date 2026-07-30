import type { JsonValue } from '@shipgate/database'

interface JobErrorOptions {
  readonly code?: string
  readonly details?: JsonValue
  readonly cause?: unknown
}

export class PermanentJobError extends Error {
  readonly code: string
  readonly details: JsonValue | undefined

  constructor(message: string, options: JobErrorOptions = {}) {
    super(message, {
      ...(options.cause !== undefined
        ? {
            cause: options.cause,
          }
        : {}),
    })

    this.name = 'PermanentJobError'
    this.code = options.code ?? 'PERMANENT_JOB_ERROR'
    this.details = options.details
  }
}

export class RetryableJobError extends Error {
  readonly code: string
  readonly details: JsonValue | undefined

  constructor(message: string, options: JobErrorOptions = {}) {
    super(message, {
      ...(options.cause !== undefined
        ? {
            cause: options.cause,
          }
        : {}),
    })

    this.name = 'RetryableJobError'
    this.code = options.code ?? 'RETRYABLE_JOB_ERROR'
    this.details = options.details
  }
}
