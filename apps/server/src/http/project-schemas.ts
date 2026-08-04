import { Type } from '@fastify/type-provider-typebox'

const BranchNameSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: '^[^\\r\\n\\u0000]+$',
})

export const CreateProjectBodySchema = Type.Object(
  {
    installationId: Type.Integer({ minimum: 1 }),
    repositoryId: Type.Integer({ minimum: 1 }),
    sourceBranch: BranchNameSchema,
    productionBranch: BranchNameSchema,
  },
  { additionalProperties: false },
)

export const UpdateProjectBodySchema = Type.Object(
  {
    expectedConfigurationVersion: Type.Integer({ minimum: 1 }),
    sourceBranch: Type.Optional(BranchNameSchema),
    productionBranch: Type.Optional(BranchNameSchema),
  },
  { additionalProperties: false, minProperties: 2 },
)

export const ProjectParamsSchema = Type.Object(
  {
    projectId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
)

export const DeleteProjectQuerySchema = Type.Object(
  {
    expectedConfigurationVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
)

export const ProjectSchema = Type.Object(
  {
    id: Type.String(),
    installationId: Type.Integer({ minimum: 1 }),
    repositoryId: Type.Integer({ minimum: 1 }),
    repository: Type.Object(
      {
        ownerId: Type.Integer({ minimum: 1 }),
        ownerLogin: Type.String(),
        name: Type.String(),
        fullName: Type.String(),
        defaultBranch: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    sourceBranch: Type.String(),
    productionBranch: Type.String(),
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('disconnected'),
      Type.Literal('pending_deletion'),
      Type.Literal('deleted'),
    ]),
    sourceSha: Type.Union([Type.String(), Type.Null()]),
    productionSha: Type.Union([Type.String(), Type.Null()]),
    lastSuccessfulSynchronization: Type.Union([Type.String(), Type.Null()]),
    configurationVersion: Type.Integer({ minimum: 1 }),
    deletionRequestedAt: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false, title: 'Project' },
)

const ReconciliationSchema = Type.Object(
  {
    requestId: Type.String(),
    status: Type.Literal('queued'),
    configurationVersion: Type.Integer({ minimum: 1 }),
    reason: Type.String(),
    mode: Type.Literal('full'),
    sourceSha: Type.String(),
    productionSha: Type.String(),
    requestedAt: Type.String(),
  },
  { additionalProperties: false },
)

export const ProjectMutationResponseSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('created'),
      Type.Literal('updated'),
      Type.Literal('already_applied'),
    ]),
    project: ProjectSchema,
    reconciliation: Type.Union([ReconciliationSchema, Type.Null()]),
  },
  { additionalProperties: false },
)

export const ProjectListSchema = Type.Object(
  {
    projects: Type.Array(ProjectSchema),
  },
  { additionalProperties: false },
)
