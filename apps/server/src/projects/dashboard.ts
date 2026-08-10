import type {
  DatabaseClient,
  DatabaseSchema,
  GitHubInstallationLifecycleState,
  GitHubInstallationPermissionState,
  JsonValue,
  ProjectStatus,
  RepositoryReconciliationClassification,
  RepositorySyncIssueScope,
  RepositorySyncIssueSeverity,
  RepositorySyncRunStatus,
  RequiredCheckSource,
  RequiredCheckState,
} from '@shipgate/database'
import type { Kysely, Selectable } from 'kysely'

import { ProjectNotFoundError } from './errors.js'
import type { ProjectCheckState, ProjectRecord } from './model.js'
import { parseRequiredCheckOverrides } from './required-checks.js'

export type ProjectHealthState =
  | 'healthy'
  | 'attention'
  | 'initializing'
  | 'synchronizing'
  | 'degraded'
  | 'disconnected'
  | 'deleting'

export interface ProjectHealthReason {
  readonly severity: 'info' | 'warning' | 'error'
  readonly code: string
  readonly message: string
}

export interface ProjectHealth {
  readonly state: ProjectHealthState
  readonly summary: string
  readonly reasons: readonly ProjectHealthReason[]
}

export interface ProjectOverviewBranch {
  readonly name: string
  readonly sha: string | null
  readonly protected: boolean | null
  readonly defaultBranch: boolean | null
  readonly observedAt: Date | null
}

export interface ProjectOverviewRequiredCheck {
  readonly id: string
  readonly context: string
  readonly integrationId: number | null
  readonly source: RequiredCheckSource
  readonly sourceReference: string | null
  readonly state: ProjectCheckState
  readonly stateCounts: Readonly<Record<RequiredCheckState, number>>
}

export interface ProjectSynchronizationIssue {
  readonly id: string
  readonly severity: RepositorySyncIssueSeverity
  readonly code: string
  readonly scope: RepositorySyncIssueScope
  readonly subjectId: string | null
  readonly message: string
  readonly details: JsonValue
  readonly createdAt: Date
}

export interface ProjectSynchronizationSummary {
  readonly id: string
  readonly status: RepositorySyncRunStatus
  readonly reason: string
  readonly configurationVersion: number
  readonly classification: RepositoryReconciliationClassification | null
  readonly sourceSha: string | null
  readonly productionSha: string | null
  readonly startedAt: Date
  readonly completedAt: Date | null
  readonly durationMs: number | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly differenceSummary: JsonValue | null
  readonly issueCount: number
}

export interface ProjectOverview {
  readonly project: ProjectRecord
  readonly branches: {
    readonly source: ProjectOverviewBranch
    readonly production: ProjectOverviewBranch
  }
  readonly counts: {
    readonly unreleasedChanges: number
    readonly partiallyPresentChanges: number
    readonly unknownChanges: number
    readonly unmanagedCommits: number
    readonly ambiguousCommits: number
  }
  readonly requiredChecks: {
    readonly policyVersion: number
    readonly state: ProjectCheckState
    readonly checks: readonly ProjectOverviewRequiredCheck[]
  }
  readonly lastSynchronization: ProjectSynchronizationSummary | null
  readonly health: ProjectHealth
}

export interface ProjectSynchronizationRun extends ProjectSynchronizationSummary {
  readonly requestedAt: Date
  readonly coalescedCount: number
  readonly forcePush: boolean
  readonly triggerScope: JsonValue | null
  readonly issues: readonly ProjectSynchronizationIssue[]
}

export interface ProjectSynchronizationHistory {
  readonly project: ProjectRecord
  readonly health: ProjectHealth
  readonly runs: readonly ProjectSynchronizationRun[]
}

type InstallationState = {
  readonly lifecycleState: GitHubInstallationLifecycleState
  readonly permissionState: GitHubInstallationPermissionState
  readonly suspendedAt: Date | null
} | null

type ProjectCounts = ProjectOverview['counts']

const checkStatePriority: Readonly<Record<ProjectCheckState, number>> = {
  failed: 7,
  missing: 6,
  stale: 5,
  unknown: 4,
  pending: 3,
  successful: 2,
  not_applicable: 1,
  not_configured: 0,
}

export async function loadProjectOverview(
  database: DatabaseClient,
  authorizedProject: ProjectRecord,
): Promise<ProjectOverview> {
  return database.kysely
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (transaction) => {
      const project = await loadCurrentProject(transaction, authorizedProject.id)

      return loadProjectOverviewSnapshot(transaction, project)
    })
}

async function loadProjectOverviewSnapshot(
  database: Kysely<DatabaseSchema>,
  project: ProjectRecord,
): Promise<ProjectOverview> {
  const [changeRows, commitRows, branchRows, requiredCheckRows, stateRows, lastRun, installation] =
    await Promise.all([
      database
        .selectFrom('changes')
        .select(['production_presence', 'synchronization_state'])
        .where('project_id', '=', project.id)
        .execute(),
      database
        .selectFrom('repository_commits')
        .select(['attribution_state', 'source_delta_position'])
        .where('project_id', '=', project.id)
        .where('source_delta_position', 'is not', null)
        .execute(),
      database
        .selectFrom('repository_branches')
        .select(['name', 'head_sha', 'protected', 'default_branch', 'observed_at'])
        .where('project_id', '=', project.id)
        .where('name', 'in', [project.sourceBranch, project.productionBranch])
        .execute(),
      project.requiredCheckPolicyVersion === 0
        ? Promise.resolve([])
        : database
            .selectFrom('required_checks')
            .select(['id', 'context', 'integration_id', 'source', 'source_reference'])
            .where('project_id', '=', project.id)
            .where('policy_version', '=', project.requiredCheckPolicyVersion)
            .orderBy('context')
            .orderBy('integration_id')
            .orderBy('source')
            .execute(),
      project.requiredCheckPolicyVersion === 0
        ? Promise.resolve([])
        : database
            .selectFrom('change_required_check_states as state')
            .innerJoin('changes as change', 'change.id', 'state.change_id')
            .select(['state.required_check_id', 'state.state'])
            .where('state.project_id', '=', project.id)
            .where('state.policy_version', '=', project.requiredCheckPolicyVersion)
            .where('change.synchronization_state', '=', 'known')
            .where('change.production_presence', 'in', ['unreleased', 'partially_present'])
            .execute(),
      database
        .selectFrom('repository_sync_runs')
        .selectAll()
        .where('project_id', '=', project.id)
        .orderBy('started_at', 'desc')
        .orderBy('created_at', 'desc')
        .executeTakeFirst(),
      loadInstallationState(database, project.installationId),
    ])

  const counts: ProjectCounts = {
    unreleasedChanges: changeRows.filter(
      (change) =>
        change.synchronization_state === 'known' && change.production_presence === 'unreleased',
    ).length,
    partiallyPresentChanges: changeRows.filter(
      (change) =>
        change.synchronization_state === 'known' &&
        change.production_presence === 'partially_present',
    ).length,
    unknownChanges: changeRows.filter(
      (change) =>
        change.synchronization_state === 'unknown' || change.production_presence === 'unknown',
    ).length,
    unmanagedCommits: commitRows.filter((commit) => commit.attribution_state === 'unmanaged')
      .length,
    ambiguousCommits: commitRows.filter((commit) => commit.attribution_state === 'ambiguous')
      .length,
  }
  const statesByCheck = new Map<string, RequiredCheckState[]>()

  for (const row of stateRows) {
    const states = statesByCheck.get(row.required_check_id) ?? []
    states.push(row.state)
    statesByCheck.set(row.required_check_id, states)
  }

  const knownChangeCount = counts.unreleasedChanges + counts.partiallyPresentChanges
  const hasKnownChangesAhead = knownChangeCount > 0
  const checks = requiredCheckRows.map((check): ProjectOverviewRequiredCheck => {
    const states = statesByCheck.get(check.id) ?? []

    return {
      id: check.id,
      context: check.context,
      integrationId: parseNullableGitHubId(check.integration_id),
      source: check.source,
      sourceReference: check.source_reference,
      state: summarizeProjectCheckState({
        configuredCheckCount: 1,
        hasKnownChangesAhead,
        expectedStateCount: knownChangeCount,
        synchronizationState: 'known',
        states,
      }),
      stateCounts: countCheckStates(states),
    }
  })
  const issueMap = lastRun ? await loadIssues(database, [lastRun.id]) : new Map()
  const lastIssues = lastRun ? (issueMap.get(lastRun.id) ?? []) : []
  const lastSynchronization = lastRun ? mapSynchronizationSummary(lastRun, lastIssues.length) : null
  const branches = new Map<
    string,
    {
      readonly head_sha: string
      readonly protected: boolean
      readonly default_branch: boolean
      readonly observed_at: Date
    }
  >(branchRows.map((branch) => [branch.name, branch] as const))
  const requiredCheckState = summarizeProjectCheckState({
    configuredCheckCount: checks.length,
    hasKnownChangesAhead,
    states: checks.map((check) => check.state),
  })
  const health = deriveProjectHealth({
    projectStatus: project.status,
    installation,
    counts,
    requiredCheckState,
    lastSynchronization,
    lastIssues,
  })

  return {
    project,
    branches: {
      source: mapBranch(
        project.sourceBranch,
        project.sourceSha,
        branches.get(project.sourceBranch),
      ),
      production: mapBranch(
        project.productionBranch,
        project.productionSha,
        branches.get(project.productionBranch),
      ),
    },
    counts,
    requiredChecks: {
      policyVersion: project.requiredCheckPolicyVersion,
      state: requiredCheckState,
      checks,
    },
    lastSynchronization,
    health,
  }
}

export async function loadProjectSynchronizationHistory(
  database: DatabaseClient,
  authorizedProject: ProjectRecord,
  limit = 30,
): Promise<ProjectSynchronizationHistory> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Synchronization history limit must be between 1 and 100')
  }

  return database.kysely
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (transaction) => {
      const project = await loadCurrentProject(transaction, authorizedProject.id)

      return loadProjectSynchronizationSnapshot(transaction, project, limit)
    })
}

async function loadProjectSynchronizationSnapshot(
  database: Kysely<DatabaseSchema>,
  project: ProjectRecord,
  limit: number,
): Promise<ProjectSynchronizationHistory> {
  const rows = await database
    .selectFrom('repository_sync_runs as run')
    .leftJoin('repository_reconciliation_requests as request', 'request.sync_run_id', 'run.id')
    .select([
      'run.id',
      'run.status',
      'run.reason',
      'run.configuration_version',
      'run.reconciliation_classification',
      'run.source_sha',
      'run.production_sha',
      'run.started_at',
      'run.completed_at',
      'run.error_code',
      'run.error_message',
      'run.difference_summary',
      'request.requested_at',
      'request.coalesced_count',
      'request.force_push',
      'request.trigger_scope',
    ])
    .where('run.project_id', '=', project.id)
    .orderBy('run.started_at', 'desc')
    .orderBy('run.created_at', 'desc')
    .limit(limit)
    .execute()
  const issueMap = await loadIssues(
    database,
    rows.map((row) => row.id),
  )
  const installation = await loadInstallationState(database, project.installationId)
  const latest = rows[0]
  const latestIssues = latest ? (issueMap.get(latest.id) ?? []) : []
  const counts = await loadProjectCounts(database, project.id)
  const requiredCheckState = await loadAggregateRequiredCheckState(database, project, counts)
  const latestSummary = latest ? mapSynchronizationSummary(latest, latestIssues.length) : null

  return {
    project,
    health: deriveProjectHealth({
      projectStatus: project.status,
      installation,
      counts,
      requiredCheckState,
      lastSynchronization: latestSummary,
      lastIssues: latestIssues,
    }),
    runs: rows.map((row) => ({
      ...mapSynchronizationSummary(row, issueMap.get(row.id)?.length ?? 0),
      requestedAt: row.requested_at ?? row.started_at,
      coalescedCount: row.coalesced_count ?? 0,
      forcePush: row.force_push ?? false,
      triggerScope: row.trigger_scope ?? null,
      issues: issueMap.get(row.id) ?? [],
    })),
  }
}

export function summarizeProjectCheckState(input: {
  readonly configuredCheckCount: number
  readonly hasKnownChangesAhead: boolean
  readonly expectedStateCount?: number
  readonly synchronizationState?: 'known' | 'unknown'
  readonly states: readonly (RequiredCheckState | ProjectCheckState)[]
}): ProjectCheckState {
  if (input.synchronizationState === 'unknown') {
    return 'unknown'
  }

  if (input.configuredCheckCount === 0) {
    return 'not_configured'
  }

  if (!input.hasKnownChangesAhead) {
    return 'not_applicable'
  }

  if (input.states.length === 0) {
    return 'missing'
  }

  if (input.expectedStateCount !== undefined && input.states.length < input.expectedStateCount) {
    return 'missing'
  }

  return input.states.reduce<ProjectCheckState>((worst, state) => {
    const normalized = state as ProjectCheckState
    return checkStatePriority[normalized] > checkStatePriority[worst] ? normalized : worst
  }, 'successful')
}

async function loadCurrentProject(
  database: Kysely<DatabaseSchema>,
  projectId: string,
): Promise<ProjectRecord> {
  const row = await database
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', projectId)
    .executeTakeFirst()

  if (!row || row.status === 'deleted') {
    throw new ProjectNotFoundError(projectId)
  }

  return mapProject(row)
}

async function loadProjectCounts(
  database: Kysely<DatabaseSchema>,
  projectId: string,
): Promise<ProjectCounts> {
  const [changes, commits] = await Promise.all([
    database
      .selectFrom('changes')
      .select(['production_presence', 'synchronization_state'])
      .where('project_id', '=', projectId)
      .execute(),
    database
      .selectFrom('repository_commits')
      .select('attribution_state')
      .where('project_id', '=', projectId)
      .where('source_delta_position', 'is not', null)
      .execute(),
  ])

  return {
    unreleasedChanges: changes.filter(
      (change) =>
        change.synchronization_state === 'known' && change.production_presence === 'unreleased',
    ).length,
    partiallyPresentChanges: changes.filter(
      (change) =>
        change.synchronization_state === 'known' &&
        change.production_presence === 'partially_present',
    ).length,
    unknownChanges: changes.filter(
      (change) =>
        change.synchronization_state === 'unknown' || change.production_presence === 'unknown',
    ).length,
    unmanagedCommits: commits.filter((commit) => commit.attribution_state === 'unmanaged').length,
    ambiguousCommits: commits.filter((commit) => commit.attribution_state === 'ambiguous').length,
  }
}

async function loadAggregateRequiredCheckState(
  database: Kysely<DatabaseSchema>,
  project: ProjectRecord,
  counts: ProjectCounts,
): Promise<ProjectCheckState> {
  const hasKnownChangesAhead = counts.unreleasedChanges + counts.partiallyPresentChanges > 0
  const knownChangeCount = counts.unreleasedChanges + counts.partiallyPresentChanges

  if (project.requiredCheckPolicyVersion === 0) {
    return summarizeProjectCheckState({
      configuredCheckCount: 0,
      hasKnownChangesAhead,
      states: [],
    })
  }

  const [requiredChecks, states] = await Promise.all([
    database
      .selectFrom('required_checks')
      .select('id')
      .where('project_id', '=', project.id)
      .where('policy_version', '=', project.requiredCheckPolicyVersion)
      .execute(),
    database
      .selectFrom('change_required_check_states as state')
      .innerJoin('changes as change', 'change.id', 'state.change_id')
      .select('state.state')
      .where('state.project_id', '=', project.id)
      .where('state.policy_version', '=', project.requiredCheckPolicyVersion)
      .where('change.synchronization_state', '=', 'known')
      .where('change.production_presence', 'in', ['unreleased', 'partially_present'])
      .execute(),
  ])

  return summarizeProjectCheckState({
    configuredCheckCount: requiredChecks.length,
    hasKnownChangesAhead,
    expectedStateCount: requiredChecks.length * knownChangeCount,
    states: states.map((row) => row.state),
  })
}

async function loadInstallationState(
  database: Kysely<DatabaseSchema>,
  installationId: string,
): Promise<InstallationState> {
  const row = await database
    .selectFrom('github_installations')
    .select(['lifecycle_state', 'permission_state', 'suspended_at'])
    .where('installation_id', '=', installationId)
    .executeTakeFirst()

  return row
    ? {
        lifecycleState: row.lifecycle_state,
        permissionState: row.permission_state,
        suspendedAt: row.suspended_at,
      }
    : null
}

async function loadIssues(
  database: Kysely<DatabaseSchema>,
  syncRunIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ProjectSynchronizationIssue[]>> {
  if (syncRunIds.length === 0) {
    return new Map()
  }

  const rows = await database
    .selectFrom('repository_sync_issues')
    .selectAll()
    .where('sync_run_id', 'in', syncRunIds)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  const grouped = new Map<string, ProjectSynchronizationIssue[]>()

  for (const row of rows) {
    const issues = grouped.get(row.sync_run_id) ?? []
    issues.push({
      id: row.id,
      severity: row.severity,
      code: row.code,
      scope: row.scope,
      subjectId: row.subject_id,
      message: row.message,
      details: row.details,
      createdAt: row.created_at,
    })
    grouped.set(row.sync_run_id, issues)
  }

  return grouped
}

function mapSynchronizationSummary(
  row: {
    readonly id: string
    readonly status: RepositorySyncRunStatus
    readonly reason: string
    readonly configuration_version: number
    readonly reconciliation_classification: RepositoryReconciliationClassification | null
    readonly source_sha: string | null
    readonly production_sha: string | null
    readonly started_at: Date
    readonly completed_at: Date | null
    readonly error_code: string | null
    readonly error_message: string | null
    readonly difference_summary: JsonValue | null
  },
  issueCount: number,
): ProjectSynchronizationSummary {
  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    configurationVersion: row.configuration_version,
    classification: row.reconciliation_classification,
    sourceSha: row.source_sha,
    productionSha: row.production_sha,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs:
      row.completed_at === null
        ? null
        : Math.max(0, row.completed_at.getTime() - row.started_at.getTime()),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    differenceSummary: row.difference_summary,
    issueCount,
  }
}

function mapBranch(
  name: string,
  fallbackSha: string | null,
  row:
    | {
        readonly head_sha: string
        readonly protected: boolean
        readonly default_branch: boolean
        readonly observed_at: Date
      }
    | undefined,
): ProjectOverviewBranch {
  return {
    name,
    sha: row?.head_sha ?? fallbackSha,
    protected: row?.protected ?? null,
    defaultBranch: row?.default_branch ?? null,
    observedAt: row?.observed_at ?? null,
  }
}

function countCheckStates(
  states: readonly RequiredCheckState[],
): Record<RequiredCheckState, number> {
  const counts: Record<RequiredCheckState, number> = {
    pending: 0,
    successful: 0,
    failed: 0,
    missing: 0,
    stale: 0,
  }

  for (const state of states) {
    counts[state] += 1
  }

  return counts
}

function deriveProjectHealth(input: {
  readonly projectStatus: ProjectStatus
  readonly installation: InstallationState
  readonly counts: ProjectCounts
  readonly requiredCheckState: ProjectCheckState
  readonly lastSynchronization: ProjectSynchronizationSummary | null
  readonly lastIssues: readonly ProjectSynchronizationIssue[]
}): ProjectHealth {
  const reasons: ProjectHealthReason[] = []
  let forcedState: ProjectHealthState | undefined

  switch (input.projectStatus) {
    case 'pending_deletion':
    case 'deleted':
      forcedState = 'deleting'
      reasons.push(reason('info', 'project_deletion_pending', 'Project removal is in progress.'))
      break
    case 'disconnected':
      forcedState = 'disconnected'
      reasons.push(
        reason(
          'error',
          'project_disconnected',
          'GitHub access is unavailable. The last committed projection remains visible but cannot be refreshed.',
        ),
      )
      break
    case 'degraded':
      forcedState = 'degraded'
      reasons.push(
        reason(
          'error',
          'project_projection_degraded',
          'Shipgate detected a repository inconsistency and is retaining the previous projection for diagnosis.',
        ),
      )
      break
    case 'initializing':
      forcedState = 'initializing'
      reasons.push(
        reason(
          'info',
          'project_initializing',
          'The first authoritative repository snapshot has not completed yet.',
        ),
      )
      break
    case 'active':
      break
  }

  if (!input.installation) {
    forcedState = 'disconnected'
    reasons.push(
      reason(
        'error',
        'installation_missing',
        'The GitHub App installation is no longer available.',
      ),
    )
  } else if (
    input.installation.lifecycleState === 'suspended' ||
    input.installation.permissionState === 'suspended'
  ) {
    forcedState = 'disconnected'
    reasons.push(
      reason(
        'error',
        'installation_suspended',
        'The GitHub App installation is suspended. Reconciliation resumes after GitHub unsuspends it.',
      ),
    )
  } else if (
    input.installation.lifecycleState === 'deleted' ||
    input.installation.lifecycleState === 'pending_deletion' ||
    input.installation.permissionState === 'revoked'
  ) {
    forcedState = 'disconnected'
    reasons.push(
      reason(
        'error',
        'installation_revoked',
        'The GitHub App installation has been removed or revoked.',
      ),
    )
  } else if (input.installation.permissionState === 'stale') {
    reasons.push(
      reason(
        'warning',
        'installation_permissions_stale',
        'GitHub installation permissions changed and have not been fully reconciled yet.',
      ),
    )
  }

  const synchronization = input.lastSynchronization

  if (synchronization?.status === 'queued' || synchronization?.status === 'running') {
    if (!forcedState || forcedState === 'initializing') {
      forcedState = input.projectStatus === 'initializing' ? 'initializing' : 'synchronizing'
    }
    reasons.push(
      reason(
        'info',
        'synchronization_in_progress',
        synchronization.status === 'queued'
          ? 'An authoritative reconciliation is queued.'
          : 'An authoritative reconciliation is running.',
      ),
    )
  }

  if (synchronization?.status === 'failed') {
    const classification = synchronization.classification

    if (classification === 'permission_problem') {
      forcedState = 'disconnected'
    } else {
      forcedState = 'degraded'
    }

    reasons.push(
      reason(
        'error',
        synchronization.errorCode ?? 'synchronization_failed',
        synchronization.errorMessage ??
          'The latest synchronization failed before a snapshot could be committed.',
      ),
    )
  }

  if (synchronization?.classification === 'destructive_history_change') {
    forcedState = 'degraded'
    reasons.push(
      reason(
        'error',
        'destructive_history_change',
        'Source or production history was rewritten. Shipgate preserved the previous snapshot and rebuilt without guessing lost change identity.',
      ),
    )
  } else if (synchronization?.classification === 'unknown_inconsistency') {
    forcedState = 'degraded'
    reasons.push(
      reason(
        'error',
        'unknown_inconsistency',
        'GitHub and the local projection still disagree in a way Shipgate cannot classify safely.',
      ),
    )
  } else if (synchronization?.classification === 'recoverable_drift') {
    reasons.push(
      reason(
        'warning',
        'recoverable_drift',
        'A missed or out-of-order update was repaired by reconciliation.',
      ),
    )
  }

  for (const issue of input.lastIssues) {
    if (reasons.some((item) => item.code === issue.code && item.message === issue.message)) {
      continue
    }

    reasons.push(reason(issue.severity, issue.code, issue.message))
  }

  if (input.counts.unknownChanges > 0) {
    forcedState = forcedState === 'disconnected' ? forcedState : 'degraded'
    reasons.push(
      reason(
        'error',
        'unknown_change_identity',
        `${input.counts.unknownChanges} change${input.counts.unknownChanges === 1 ? '' : 's'} lost stable identity after repository history changed.`,
      ),
    )
  }

  if (input.counts.ambiguousCommits > 0) {
    forcedState = forcedState === 'disconnected' ? forcedState : 'degraded'
    reasons.push(
      reason(
        'error',
        'ambiguous_commit_attribution',
        `${input.counts.ambiguousCommits} commit${input.counts.ambiguousCommits === 1 ? '' : 's'} have conflicting pull-request attribution evidence.`,
      ),
    )
  }

  if (input.counts.partiallyPresentChanges > 0) {
    forcedState = forcedState === 'disconnected' ? forcedState : 'degraded'
    reasons.push(
      reason(
        'error',
        'partial_production_presence',
        `${input.counts.partiallyPresentChanges} change${input.counts.partiallyPresentChanges === 1 ? '' : 's'} are only partially present in production.`,
      ),
    )
  }

  if (input.counts.unmanagedCommits > 0) {
    reasons.push(
      reason(
        'warning',
        'unmanaged_commits',
        `${input.counts.unmanagedCommits} direct commit${input.counts.unmanagedCommits === 1 ? '' : 's'} cannot be attributed to a merged pull request.`,
      ),
    )
  }

  if (['failed', 'missing', 'stale', 'unknown', 'pending'].includes(input.requiredCheckState)) {
    const messageByState: Readonly<Record<string, string>> = {
      failed: 'At least one required check is failing for an unreleased change.',
      missing: 'At least one required check has no matching GitHub result.',
      stale: 'At least one required check result is stale.',
      unknown: 'Required-check state cannot be trusted while change identity is unknown.',
      pending: 'At least one required check is still pending.',
    }
    reasons.push(
      reason(
        input.requiredCheckState === 'failed' || input.requiredCheckState === 'missing'
          ? 'error'
          : 'warning',
        `required_checks_${input.requiredCheckState}`,
        messageByState[input.requiredCheckState] ?? 'Required checks need attention.',
      ),
    )
  }

  const state = forcedState ?? (reasons.length > 0 ? 'attention' : 'healthy')

  return {
    state,
    summary: healthSummary(state),
    reasons,
  }
}

function reason(
  severity: ProjectHealthReason['severity'],
  code: string,
  message: string,
): ProjectHealthReason {
  return { severity, code, message }
}

function healthSummary(state: ProjectHealthState): string {
  switch (state) {
    case 'healthy':
      return 'Projection is current and internally consistent.'
    case 'attention':
      return 'Projection is usable, but one or more release signals need attention.'
    case 'initializing':
      return 'Initial repository synchronization is still in progress.'
    case 'synchronizing':
      return 'Repository reconciliation is in progress.'
    case 'degraded':
      return 'Projection is retained for diagnosis but cannot be treated as fully authoritative.'
    case 'disconnected':
      return 'GitHub access is unavailable; the last committed projection is read-only.'
    case 'deleting':
      return 'Project deletion is in progress.'
  }
}

function mapProject(row: Selectable<DatabaseSchema['projects']>): ProjectRecord {
  return {
    id: row.id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    ownerId: row.owner_id,
    ownerLogin: row.owner_login,
    repositoryName: row.repository_name,
    repositoryFullName: row.repository_full_name,
    defaultBranch: row.default_branch,
    sourceBranch: row.source_branch,
    productionBranch: row.production_branch,
    status: row.status,
    sourceSha: row.source_sha,
    productionSha: row.production_sha,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    mergeBaseSha: row.merge_base_sha,
    configurationVersion: row.configuration_version,
    requiredCheckPolicyVersion: row.required_check_policy_version,
    requiredCheckOverrides: parseRequiredCheckOverrides(row.required_check_overrides),
    deletionRequestedAt: row.deletion_requested_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseNullableGitHubId(value: string | null): number | null {
  if (value === null) {
    return null
  }

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Stored GitHub numeric ID is invalid: ${value}`)
  }

  return parsed
}
