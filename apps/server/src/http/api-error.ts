import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { ApiError } from './schemas.js'

interface ApiHttpErrorOptions {
  readonly statusCode: number
  readonly code: string
  readonly message: string
  readonly details?: unknown
  readonly cause?: unknown
}

export class ApiHttpError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details: unknown | undefined

  constructor(options: ApiHttpErrorOptions) {
    super(options.message, {
      ...(options.cause !== undefined
        ? {
            cause: options.cause,
          }
        : {}),
    })

    this.name = 'ApiHttpError'
    this.statusCode = options.statusCode
    this.code = options.code
    this.details = options.details
  }
}

interface MappedApiError {
  readonly statusCode: number
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

export function registerApiErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler(async (request, reply) => {
    await sendApiError(request, reply, {
      statusCode: 404,
      code: 'ROUTE_NOT_FOUND',
      message: 'Route not found',
    })
  })

  app.setErrorHandler(async (error, request, reply) => {
    const mapped = mapFastifyError(error)

    if (mapped.statusCode >= 500) {
      request.log.error(
        {
          event: 'http.request.failed',
          err: error,

          apiError: {
            code: mapped.code,

            statusCode: mapped.statusCode,
          },
        },
        'HTTP request failed',
      )
    } else {
      request.log.info(
        {
          event: 'http.request.rejected',

          apiError: {
            code: mapped.code,

            statusCode: mapped.statusCode,
          },
        },
        'HTTP request rejected',
      )
    }

    await sendApiError(request, reply, mapped)
  })
}

async function sendApiError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: MappedApiError,
): Promise<void> {
  if (reply.sent) {
    return
  }

  const body: ApiError = {
    code: error.code,
    message: error.message,
    requestId: request.id,

    ...(error.details !== undefined
      ? {
          details: error.details,
        }
      : {}),
  }

  await reply.code(error.statusCode).type('application/json').send(body)
}

function mapFastifyError(error: unknown): MappedApiError {
  if (error instanceof ApiHttpError) {
    return {
      statusCode: error.statusCode,

      code: error.code,
      message: error.message,

      ...(error.details !== undefined
        ? {
            details: error.details,
          }
        : {}),
    }
  }

  if (!(error instanceof Error)) {
    return {
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred',
    }
  }

  const fastifyError = error as FastifyError

  if (fastifyError.validation !== undefined) {
    return {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',

      details: {
        context: fastifyError.validationContext,

        issues: fastifyError.validation.map((issue) => ({
          path: issue.instancePath || issue.schemaPath,

          keyword: issue.keyword,

          message: issue.message ?? 'Invalid value',

          params: issue.params,
        })),
      },
    }
  }

  switch (fastifyError.code) {
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return {
        statusCode: 400,
        code: 'INVALID_JSON',
        message: 'Request body must contain valid JSON',
      }

    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return {
        statusCode: 415,

        code: 'UNSUPPORTED_MEDIA_TYPE',

        message: 'Content-Type must be application/json',
      }

    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return {
        statusCode: 413,
        code: 'BODY_TOO_LARGE',
        message: 'Request body is too large',
      }

    default:
      return {
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred',
      }
  }
}
