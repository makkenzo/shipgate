export interface ApiErrorPayload {
  readonly code: string
  readonly message: string
  readonly requestId: string
  readonly details?: unknown
}

export class ApiClientError extends Error {
  readonly code: string
  readonly requestId: string | undefined

  readonly details: unknown

  constructor(
    message: string,
    options: {
      readonly code: string
      readonly requestId?: string
      readonly details?: unknown
      readonly cause?: unknown
    },
  ) {
    super(message, {
      ...(options.cause !== undefined
        ? {
            cause: options.cause,
          }
        : {}),
    })

    this.name = 'ApiClientError'
    this.code = options.code
    this.requestId = options.requestId
    this.details = options.details
  }
}

export function normalizeApiError(value: unknown): ApiClientError {
  const payload = getApiErrorPayload(value)

  if (payload) {
    return new ApiClientError(payload.message, {
      code: payload.code,

      requestId: payload.requestId,

      details: payload.details,

      cause: value,
    })
  }

  if (value instanceof Error) {
    return new ApiClientError(value.message, {
      code: 'UNKNOWN_API_ERROR',

      cause: value,
    })
  }

  return new ApiClientError('Unable to communicate with the API', {
    code: 'UNKNOWN_API_ERROR',
    cause: value,
  })
}

function getApiErrorPayload(value: unknown): ApiErrorPayload | undefined {
  if (isApiErrorPayload(value)) {
    return value
  }

  if (isRecord(value) && isApiErrorPayload(value.error)) {
    return value.error
  }

  return undefined
}

function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    typeof value.requestId === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
