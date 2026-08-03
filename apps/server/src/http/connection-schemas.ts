import { Type } from '@fastify/type-provider-typebox'

const PermissionSchema = Type.Object(
  {
    name: Type.String(),
    required: Type.Union([Type.Literal('read'), Type.Literal('write')]),
    actual: Type.Union([Type.Literal('read'), Type.Literal('write'), Type.Null()]),
    satisfied: Type.Boolean(),
  },
  { additionalProperties: false },
)

const InstallationSummarySchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    owner: Type.Object(
      {
        id: Type.Integer({ minimum: 1 }),
        login: Type.String({ minLength: 1 }),
        type: Type.String({ minLength: 1 }),
        avatarUrl: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    repositorySelection: Type.Union([Type.Literal('all'), Type.Literal('selected')]),
    lifecycleState: Type.Union([
      Type.Literal('active'),
      Type.Literal('suspended'),
      Type.Literal('pending_deletion'),
      Type.Literal('deleted'),
    ]),
    permissionState: Type.Union([
      Type.Literal('current'),
      Type.Literal('stale'),
      Type.Literal('suspended'),
      Type.Literal('revoked'),
    ]),
    suspendedAt: Type.Union([Type.String(), Type.Null()]),
    repositoryCount: Type.Integer({ minimum: 0 }),
    userRepositoryCount: Type.Integer({ minimum: 0 }),
    permissions: Type.Array(PermissionSchema),
    permissionUpgradePending: Type.Boolean(),
    lastReconciledAt: Type.String(),
  },
  { additionalProperties: false },
)

const RepositorySchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    ownerId: Type.Integer({ minimum: 1 }),
    ownerLogin: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    fullName: Type.String({ minLength: 1 }),
    private: Type.Boolean(),
    archived: Type.Boolean(),
    disabled: Type.Boolean(),
    defaultBranch: Type.Union([Type.String(), Type.Null()]),
    visibility: Type.Union([Type.String(), Type.Null()]),
    userPermission: Type.Union([
      Type.Literal('none'),
      Type.Literal('read'),
      Type.Literal('triage'),
      Type.Literal('write'),
      Type.Literal('maintain'),
      Type.Literal('admin'),
    ]),
    accessibleToUser: Type.Boolean(),
    lastReconciledAt: Type.String(),
  },
  { additionalProperties: false },
)

export const ConnectionConfigurationSchema = Type.Object(
  {
    githubLoginConfigured: Type.Boolean(),
    githubInstallationConfigured: Type.Boolean(),
    loginUrl: Type.String(),
    installUrl: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
)

export const InstallationListSchema = Type.Object(
  {
    installations: Type.Array(InstallationSummarySchema),
  },
  { additionalProperties: false },
)

export const InstallationDetailSchema = Type.Object(
  {
    ...InstallationSummarySchema.properties,
    repositories: Type.Array(RepositorySchema),
    manageUrl: Type.String(),
  },
  { additionalProperties: false },
)

export const InstallationParamsSchema = Type.Object(
  {
    installationId: Type.String({ pattern: '^[1-9][0-9]*$' }),
  },
  { additionalProperties: false },
)
