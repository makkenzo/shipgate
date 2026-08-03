import { Type } from '@fastify/type-provider-typebox'

const GitHubInstallationAccountSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    login: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
    avatarUrl: Type.Union([Type.String(), Type.Null()]),
  },
  {
    additionalProperties: false,
  },
)

const GitHubInstallationSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    account: GitHubInstallationAccountSchema,
    repositorySelection: Type.Union([Type.Literal('all'), Type.Literal('selected')]),
    permissions: Type.Record(Type.String(), Type.String()),
    suspendedAt: Type.Union([Type.String(), Type.Null()]),
  },
  {
    additionalProperties: false,
  },
)

const GitHubUserSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    login: Type.String({ minLength: 1 }),
    avatarUrl: Type.Union([Type.String(), Type.Null()]),
    displayName: Type.Union([Type.String(), Type.Null()]),
    email: Type.Union([Type.String(), Type.Null()]),
    htmlUrl: Type.String({ minLength: 1 }),
    installations: Type.Array(GitHubInstallationSchema),
  },
  {
    additionalProperties: false,
  },
)

export const GitHubLoginQuerySchema = Type.Object(
  {
    returnTo: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  {
    additionalProperties: false,
  },
)

export const GitHubCallbackQuerySchema = Type.Object(
  {
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    state: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    error: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    error_description: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    installation_id: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
    setup_action: Type.Optional(
      Type.Union([Type.Literal('install'), Type.Literal('update'), Type.Literal('request')]),
    ),
  },
  {
    additionalProperties: false,
  },
)

export const EmptyMutationBodySchema = Type.Object(
  {},
  {
    additionalProperties: false,
  },
)

export const CsrfHeadersSchema = Type.Object(
  {
    'x-csrf-token': Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  {
    additionalProperties: true,
  },
)

export const AuthSessionResponseSchema = Type.Union(
  [
    Type.Object(
      {
        authenticated: Type.Literal(false),
      },
      {
        additionalProperties: false,
      },
    ),
    Type.Object(
      {
        authenticated: Type.Literal(true),
        session: Type.Object(
          {
            id: Type.String({ minLength: 1 }),
            expiresAt: Type.String({ minLength: 1 }),
          },
          {
            additionalProperties: false,
          },
        ),
        user: GitHubUserSchema,
      },
      {
        additionalProperties: false,
      },
    ),
  ],
  {
    title: 'AuthSessionResponse',
  },
)
