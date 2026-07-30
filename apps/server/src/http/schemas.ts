import { type Static, Type } from '@fastify/type-provider-typebox'

export const ApiErrorSchema = Type.Object(
  {
    code: Type.String({
      minLength: 1,
      examples: ['VALIDATION_ERROR'],
    }),

    message: Type.String({
      minLength: 1,
    }),

    requestId: Type.String({
      minLength: 1,
    }),

    details: Type.Optional(Type.Unknown()),
  },
  {
    additionalProperties: false,
    title: 'ApiError',
    description: 'Common error response returned by the Shipgate API.',
  },
)

export type ApiError = Static<typeof ApiErrorSchema>

export const HealthResponseSchema = Type.Object(
  {
    status: Type.Literal('ok'),

    version: Type.String(),

    uptimeSeconds: Type.Integer({
      minimum: 0,
    }),
  },
  {
    additionalProperties: false,
    title: 'HealthResponse',
  },
)

export const ReadyResponseSchema = Type.Object(
  {
    status: Type.Literal('ready'),

    checks: Type.Object(
      {
        database: Type.Object(
          {
            status: Type.Literal('ok'),

            latencyMs: Type.Number({
              minimum: 0,
            }),
          },
          {
            additionalProperties: false,
          },
        ),

        jobQueue: Type.Object(
          {
            status: Type.Literal('ok'),
          },
          {
            additionalProperties: false,
          },
        ),
      },
      {
        additionalProperties: false,
      },
    ),
  },
  {
    additionalProperties: false,
    title: 'ReadyResponse',
  },
)
