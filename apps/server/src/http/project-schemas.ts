import { Type } from '@fastify/type-provider-typebox'

const BranchNameSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: '^[^\\r\\n\\u0000]+$',
})

const RequiredCheckOverrideSchema = Type.Object(
  {
    context: Type.String({ minLength: 1, maxLength: 255, pattern: '^[^\\r\\n\\u0000]+$' }),
    integrationId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
)

export const CreateProjectBodySchema = Type.Object(
  {
    installationId: Type.Integer({ minimum: 1 }),
    repositoryId: Type.Integer({ minimum: 1 }),
    sourceBranch: BranchNameSchema,
    productionBranch: BranchNameSchema,
    requiredCheckOverrides: Type.Optional(
      Type.Array(RequiredCheckOverrideSchema, { maxItems: 100 }),
    ),
  },
  { additionalProperties: false },
)

export const UpdateProjectBodySchema = Type.Object(
  {
    expectedConfigurationVersion: Type.Integer({ minimum: 1 }),
    sourceBranch: Type.Optional(BranchNameSchema),
    productionBranch: Type.Optional(BranchNameSchema),
    requiredCheckOverrides: Type.Optional(
      Type.Array(RequiredCheckOverrideSchema, { maxItems: 100 }),
    ),
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
      Type.Literal('initializing'),
      Type.Literal('active'),
      Type.Literal('degraded'),
      Type.Literal('disconnected'),
      Type.Literal('pending_deletion'),
      Type.Literal('deleted'),
    ]),
    sourceSha: Type.Union([Type.String(), Type.Null()]),
    productionSha: Type.Union([Type.String(), Type.Null()]),
    lastSuccessfulSynchronization: Type.Union([Type.String(), Type.Null()]),
    configurationVersion: Type.Integer({ minimum: 1 }),
    requiredCheckPolicyVersion: Type.Integer({ minimum: 0 }),
    requiredCheckOverrides: Type.Array(RequiredCheckOverrideSchema),
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
const RequiredCheckObservationSchema = Type.Object(
  {
    id: Type.Union([Type.String(), Type.Null()]),
    type: Type.Union([Type.Literal('check_run'), Type.Literal('commit_status')]),
    integrationId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    githubObjectId: Type.String(),
    attempt: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    status: Type.Union([
      Type.Literal('queued'),
      Type.Literal('in_progress'),
      Type.Literal('pending'),
      Type.Literal('completed'),
    ]),
    conclusion: Type.Union([
      Type.Literal('success'),
      Type.Literal('failure'),
      Type.Literal('neutral'),
      Type.Literal('cancelled'),
      Type.Literal('skipped'),
      Type.Literal('timed_out'),
      Type.Literal('action_required'),
      Type.Literal('stale'),
      Type.Literal('startup_failure'),
      Type.Literal('error'),
      Type.Null(),
    ]),
    detailsUrl: Type.Union([Type.String(), Type.Null()]),
    startedAt: Type.Union([Type.String(), Type.Null()]),
    completedAt: Type.Union([Type.String(), Type.Null()]),
    observedAt: Type.String(),
  },
  { additionalProperties: false },
)

const ChangeRequiredCheckStateSchema = Type.Object(
  {
    requiredCheckId: Type.String(),
    policyVersion: Type.Integer({ minimum: 1 }),
    context: Type.String(),
    integrationId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    source: Type.Union([
      Type.Literal('branch_protection'),
      Type.Literal('repository_ruleset'),
      Type.Literal('project_override'),
    ]),
    sourceReference: Type.Union([Type.String(), Type.Null()]),
    commitSha: Type.String(),
    state: Type.Union([
      Type.Literal('pending'),
      Type.Literal('successful'),
      Type.Literal('failed'),
      Type.Literal('missing'),
      Type.Literal('stale'),
    ]),
    observations: Type.Array(RequiredCheckObservationSchema),
    observedAt: Type.String(),
  },
  { additionalProperties: false },
)

export const ProjectChangesSchema = Type.Object(
  {
    changes: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          githubPullRequestId: Type.Integer({ minimum: 1 }),
          pullRequestNumber: Type.Integer({ minimum: 1 }),
          title: Type.String(),
          authorId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
          authorLogin: Type.Union([Type.String(), Type.Null()]),
          mergedAt: Type.String(),
          mergeMethod: Type.Union([
            Type.Literal('merge'),
            Type.Literal('squash'),
            Type.Literal('rebase'),
            Type.Literal('unknown'),
          ]),
          commitSetFingerprint: Type.String(),
          productionPresence: Type.Union([
            Type.Literal('unreleased'),
            Type.Literal('partially_present'),
          ]),
          finalHeadSha: Type.String(),
          commitShas: Type.Array(Type.String()),
          requiredChecks: Type.Array(ChangeRequiredCheckStateSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
