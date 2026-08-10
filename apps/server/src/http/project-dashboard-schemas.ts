import { Type } from '@fastify/type-provider-typebox'

import { ProjectReconciliationSchema, ProjectSchema } from './project-schemas.js'

const ProjectCheckStateSchema = Type.Union([
  Type.Literal('not_configured'),
  Type.Literal('not_applicable'),
  Type.Literal('successful'),
  Type.Literal('pending'),
  Type.Literal('failed'),
  Type.Literal('missing'),
  Type.Literal('stale'),
  Type.Literal('unknown'),
])

const ProjectHealthSchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal('healthy'),
      Type.Literal('attention'),
      Type.Literal('initializing'),
      Type.Literal('synchronizing'),
      Type.Literal('degraded'),
      Type.Literal('disconnected'),
      Type.Literal('deleting'),
    ]),
    summary: Type.String(),
    reasons: Type.Array(
      Type.Object(
        {
          severity: Type.Union([
            Type.Literal('info'),
            Type.Literal('warning'),
            Type.Literal('error'),
          ]),
          code: Type.String(),
          message: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

const SynchronizationSummarySchema = Type.Object(
  {
    id: Type.String(),
    status: Type.Union([
      Type.Literal('queued'),
      Type.Literal('running'),
      Type.Literal('succeeded'),
      Type.Literal('superseded'),
      Type.Literal('failed'),
    ]),
    reason: Type.String(),
    configurationVersion: Type.Integer({ minimum: 1 }),
    classification: Type.Union([
      Type.Literal('expected_change'),
      Type.Literal('recoverable_drift'),
      Type.Literal('destructive_history_change'),
      Type.Literal('permission_problem'),
      Type.Literal('unknown_inconsistency'),
      Type.Null(),
    ]),
    sourceSha: Type.Union([Type.String(), Type.Null()]),
    productionSha: Type.Union([Type.String(), Type.Null()]),
    startedAt: Type.String(),
    completedAt: Type.Union([Type.String(), Type.Null()]),
    durationMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    errorCode: Type.Union([Type.String(), Type.Null()]),
    errorMessage: Type.Union([Type.String(), Type.Null()]),
    differenceSummary: Type.Unknown(),
    issueCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)

const BranchSchema = Type.Object(
  {
    name: Type.String(),
    sha: Type.Union([Type.String(), Type.Null()]),
    protected: Type.Union([Type.Boolean(), Type.Null()]),
    defaultBranch: Type.Union([Type.Boolean(), Type.Null()]),
    observedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
)

const RequiredCheckSchema = Type.Object(
  {
    id: Type.String(),
    context: Type.String(),
    integrationId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    source: Type.Union([
      Type.Literal('branch_protection'),
      Type.Literal('repository_ruleset'),
      Type.Literal('project_override'),
    ]),
    sourceReference: Type.Union([Type.String(), Type.Null()]),
    state: ProjectCheckStateSchema,
    stateCounts: Type.Object(
      {
        pending: Type.Integer({ minimum: 0 }),
        successful: Type.Integer({ minimum: 0 }),
        failed: Type.Integer({ minimum: 0 }),
        missing: Type.Integer({ minimum: 0 }),
        stale: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

const SynchronizationIssueSchema = Type.Object(
  {
    id: Type.String(),
    severity: Type.Union([Type.Literal('warning'), Type.Literal('error')]),
    code: Type.String(),
    scope: Type.Union([
      Type.Literal('repository'),
      Type.Literal('branch'),
      Type.Literal('change'),
      Type.Literal('commit'),
      Type.Literal('check'),
    ]),
    subjectId: Type.Union([Type.String(), Type.Null()]),
    message: Type.String(),
    details: Type.Unknown(),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
)

export const ProjectOverviewSchema = Type.Object(
  {
    project: ProjectSchema,
    branches: Type.Object(
      {
        source: BranchSchema,
        production: BranchSchema,
      },
      { additionalProperties: false },
    ),
    counts: Type.Object(
      {
        unreleasedChanges: Type.Integer({ minimum: 0 }),
        partiallyPresentChanges: Type.Integer({ minimum: 0 }),
        unknownChanges: Type.Integer({ minimum: 0 }),
        unmanagedCommits: Type.Integer({ minimum: 0 }),
        ambiguousCommits: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    requiredChecks: Type.Object(
      {
        policyVersion: Type.Integer({ minimum: 0 }),
        state: ProjectCheckStateSchema,
        checks: Type.Array(RequiredCheckSchema),
      },
      { additionalProperties: false },
    ),
    lastSynchronization: Type.Union([SynchronizationSummarySchema, Type.Null()]),
    health: ProjectHealthSchema,
  },
  { additionalProperties: false, title: 'ProjectOverview' },
)

const SynchronizationRunSchema = Type.Object(
  {
    ...SynchronizationSummarySchema.properties,
    requestedAt: Type.String(),
    coalescedCount: Type.Integer({ minimum: 0 }),
    forcePush: Type.Boolean(),
    triggerScope: Type.Unknown(),
    issues: Type.Array(SynchronizationIssueSchema),
  },
  { additionalProperties: false },
)

export const ProjectSynchronizationQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
  },
  { additionalProperties: false },
)

export const ProjectSynchronizationSchema = Type.Object(
  {
    project: ProjectSchema,
    health: ProjectHealthSchema,
    runs: Type.Array(SynchronizationRunSchema),
  },
  { additionalProperties: false, title: 'ProjectSynchronization' },
)

export const ProjectReconcileBodySchema = Type.Object(
  {
    expectedConfigurationVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
)

export const ProjectReconcileResponseSchema = Type.Object(
  {
    reconciliation: ProjectReconciliationSchema,
  },
  { additionalProperties: false },
)
