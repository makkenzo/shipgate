import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'

import type { DatabaseClient, JsonValue } from '@shipgate/database'
import type { GitHubWebhookProjectionExecution } from '@shipgate/jobs'
import { sql } from 'kysely'
import { touchProjectReleaseStateAndQueueEvaluation } from './candidate-evaluation-queue.js'
import { type ChangeDependencyEdge, findDependencyCycle } from './dependency-graph.js'
import { parseManagedDependencyBlock } from './dependency-managed-block.js'
import { ChangeNotFoundError, ProjectNotFoundError } from './errors.js'
import {
  assertRepositoryTransaction,
  type RepositoryTransaction,
  withRepositoryTransaction,
} from './repository-transaction.js'

export type DependencyValidationCode =
  | 'dependency_self_reference'
  | 'dependency_target_not_found'
  | 'dependency_target_not_merged'
  | 'dependency_identity_unknown'
  | 'dependency_cycle'
  | 'invalid_dependency_block'
  | 'project_not_active'

export class DependencyValidationError extends Error {
  readonly code: DependencyValidationCode
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(
    code: DependencyValidationCode,
    message: string,
    options: {
      readonly details?: Readonly<Record<string, unknown>>
      readonly cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DependencyValidationError'
    this.code = code
    this.details = options.details
  }
}

export interface SetDependencies {
  readonly actorGitHubUserId: number | null
  readonly projectId: string
  readonly changeId: string
  readonly dependencyChangeIds: readonly string[]
  readonly source: 'user' | 'managed_pr_body'
  readonly correlationId: string
  readonly now?: Date
}

export interface RemoveDependency {
  readonly actorGitHubUserId: number
  readonly projectId: string
  readonly changeId: string
  readonly dependencyChangeId: string
  readonly correlationId: string
  readonly now?: Date
}

export interface ChangeDependencyState {
  readonly changeId: string
  readonly pullRequestNumber: number
  readonly source: 'user' | 'managed_pr_body' | 'system'
  readonly actorGitHubUserId: string | null
  readonly version: number
  readonly updatedAt: Date
}

export interface CandidateDependencyReevaluation {
  readonly candidateId: string
  readonly candidateVersion: number
}

export interface DependencyMutationResult {
  readonly status: 'recorded' | 'already_applied'
  readonly dependentChangeId: string
  readonly dependentPullRequestNumber: number
  readonly dependencies: readonly ChangeDependencyState[]
  readonly candidateReevaluation: CandidateDependencyReevaluation | null
}

export interface PreparedDependencyMutation {
  readonly projectId: string
  readonly repositoryId: string
  readonly configurationVersion: number
  readonly dependentChangeId: string
  readonly dependentPullRequestNumber: number
  readonly previousDependencies: readonly ChangeDependencyState[]
  readonly previousDependencyChangeIds: readonly string[]
  readonly previousDependencyPullRequestNumbers: readonly number[]
  readonly desiredDependencies: readonly {
    readonly changeId: string
    readonly pullRequestNumber: number
  }[]
  readonly nextVersion: number
  readonly graphChanged: boolean
  readonly commandKind: 'set' | 'remove' | 'import'
}

export async function listChangeDependencies(
  database: DatabaseClient,
  projectId: string,
  changeId: string,
): Promise<readonly ChangeDependencyState[]> {
  assertLocalId(projectId, 'project ID')
  assertLocalId(changeId, 'change ID')

  const rows = await database.kysely
    .selectFrom('change_dependencies as dependency')
    .innerJoin('changes as prerequisite', (join) =>
      join
        .onRef('prerequisite.project_id', '=', 'dependency.project_id')
        .onRef('prerequisite.repository_id', '=', 'dependency.repository_id')
        .onRef('prerequisite.id', '=', 'dependency.prerequisite_change_id'),
    )
    .select([
      'dependency.prerequisite_change_id as change_id',
      'prerequisite.pull_request_number as pull_request_number',
      'dependency.source',
      'dependency.actor_github_user_id',
      'dependency.version',
      'dependency.updated_at',
    ])
    .where('dependency.project_id', '=', projectId)
    .where('dependency.dependent_change_id', '=', changeId)
    .orderBy('prerequisite.pull_request_number')
    .orderBy('dependency.prerequisite_change_id')
    .execute()

  return rows.map((row) => ({
    changeId: row.change_id,
    pullRequestNumber: row.pull_request_number,
    source: row.source,
    actorGitHubUserId: row.actor_github_user_id,
    version: row.version,
    updatedAt: row.updated_at,
  }))
}

export async function prepareSetDependencies(
  scope: RepositoryTransaction,
  command: SetDependencies,
  commandKind: PreparedDependencyMutation['commandKind'] = command.source === 'managed_pr_body'
    ? 'import'
    : 'set',
): Promise<PreparedDependencyMutation> {
  const repositoryId = assertRepositoryTransaction(scope, scope.repositoryId)
  const dependencyChangeIds = normalizeChangeIds(command.dependencyChangeIds)

  assertLocalId(command.projectId, 'project ID')
  assertLocalId(command.changeId, 'change ID')
  assertCorrelationId(command.correlationId)

  if (dependencyChangeIds.length > 100) {
    throw new DependencyValidationError(
      'dependency_target_not_found',
      'A change cannot have more than 100 direct dependencies',
    )
  }

  if (dependencyChangeIds.includes(command.changeId)) {
    throw new DependencyValidationError(
      'dependency_self_reference',
      `Change ${command.changeId} cannot depend on itself`,
      { details: { changeId: command.changeId } },
    )
  }

  const project = await scope.transaction
    .selectFrom('projects')
    .select(['id', 'repository_id', 'configuration_version', 'status'])
    .where('id', '=', command.projectId)
    .forUpdate()
    .executeTakeFirst()

  if (!project || project.status === 'deleted' || project.repository_id !== repositoryId) {
    throw new ProjectNotFoundError(command.projectId)
  }

  if (project.status !== 'active') {
    throw new DependencyValidationError(
      'project_not_active',
      `Project ${project.id} is ${project.status} and cannot accept dependency changes`,
      { details: { projectId: project.id, status: project.status } },
    )
  }

  const dependent = await scope.transaction
    .selectFrom('changes')
    .select(['id', 'pull_request_number', 'synchronization_state'])
    .where('id', '=', command.changeId)
    .where('project_id', '=', project.id)
    .where('repository_id', '=', repositoryId)
    .forUpdate()
    .executeTakeFirst()

  if (!dependent) {
    throw new ChangeNotFoundError(project.id, command.changeId)
  }

  if (dependent.synchronization_state !== 'known') {
    throw new DependencyValidationError(
      'dependency_identity_unknown',
      `Change ${dependent.id} does not have a stable identity in the current projection`,
      { details: { changeId: dependent.id } },
    )
  }

  const targets =
    dependencyChangeIds.length === 0
      ? []
      : await scope.transaction
          .selectFrom('changes')
          .select(['id', 'pull_request_number', 'merged_at', 'synchronization_state'])
          .where('project_id', '=', project.id)
          .where('repository_id', '=', repositoryId)
          .where('id', 'in', dependencyChangeIds)
          .forUpdate()
          .execute()
  const targetsById = new Map(targets.map((target) => [target.id, target] as const))

  for (const dependencyChangeId of dependencyChangeIds) {
    const target = targetsById.get(dependencyChangeId)

    if (!target) {
      throw new DependencyValidationError(
        'dependency_target_not_found',
        `Dependency change ${dependencyChangeId} does not exist in the current Project projection`,
        { details: { dependencyChangeId, projectId: project.id } },
      )
    }

    if (target.synchronization_state !== 'known') {
      throw new DependencyValidationError(
        'dependency_identity_unknown',
        `Dependency change ${dependencyChangeId} does not have a stable identity in the current projection`,
        { details: { dependencyChangeId, projectId: project.id } },
      )
    }

    if (!target.merged_at) {
      throw new DependencyValidationError(
        'dependency_target_not_merged',
        `Dependency pull request #${target.pull_request_number} is not merged`,
        {
          details: {
            dependencyChangeId,
            pullRequestNumber: target.pull_request_number,
          },
        },
      )
    }
  }

  const existingRows = await scope.transaction
    .selectFrom('change_dependencies')
    .select([
      'dependent_change_id',
      'prerequisite_change_id',
      'source',
      'actor_github_user_id',
      'version',
      'updated_at',
    ])
    .where('project_id', '=', project.id)
    .where('repository_id', '=', repositoryId)
    .orderBy('dependent_change_id')
    .orderBy('prerequisite_change_id')
    .execute()
  const replacementEdges: ChangeDependencyEdge[] = existingRows
    .filter((row) => row.dependent_change_id !== dependent.id)
    .map((row) => ({
      dependentChangeId: row.dependent_change_id,
      prerequisiteChangeId: row.prerequisite_change_id,
    }))

  replacementEdges.push(
    ...dependencyChangeIds.map((dependencyChangeId) => ({
      dependentChangeId: dependent.id,
      prerequisiteChangeId: dependencyChangeId,
    })),
  )

  const cycle = findDependencyCycle(replacementEdges)

  if (cycle) {
    throw new DependencyValidationError(
      'dependency_cycle',
      `Dependency update would create a cycle: ${cycle.join(' -> ')}`,
      { details: { cycle } },
    )
  }

  const previousRows = existingRows.filter((row) => row.dependent_change_id === dependent.id)
  const previousTargetIds = previousRows.map((row) => row.prerequisite_change_id).toSorted()
  const previousTargets =
    previousTargetIds.length === 0
      ? []
      : await scope.transaction
          .selectFrom('changes')
          .select(['id', 'pull_request_number'])
          .where('project_id', '=', project.id)
          .where('repository_id', '=', repositoryId)
          .where('id', 'in', previousTargetIds)
          .execute()
  const previousTargetsById = new Map(
    previousTargets.map((target) => [target.id, target.pull_request_number] as const),
  )
  const previousDependencyPullRequestNumbers = previousTargetIds
    .map((changeId) => previousTargetsById.get(changeId))
    .filter((pullRequestNumber): pullRequestNumber is number => pullRequestNumber !== undefined)
    .toSorted((left, right) => left - right)
  const desiredTargetIds = [...dependencyChangeIds].toSorted()
  const graphChanged = !sameStrings(previousTargetIds, desiredTargetIds)
  const nextVersion = previousRows.reduce((maximum, row) => Math.max(maximum, row.version), 0) + 1
  const desiredDependencies = dependencyChangeIds
    .map((changeId) => {
      const target = targetsById.get(changeId)

      if (!target) {
        throw new Error(`Validated dependency ${changeId} disappeared from the target map`)
      }

      return { changeId, pullRequestNumber: target.pull_request_number }
    })
    .toSorted(
      (left, right) =>
        left.pullRequestNumber - right.pullRequestNumber ||
        left.changeId.localeCompare(right.changeId),
    )
  const previousDependencies = previousRows
    .map((row) => {
      const pullRequestNumber = previousTargetsById.get(row.prerequisite_change_id)

      if (pullRequestNumber === undefined) {
        return null
      }

      return {
        changeId: row.prerequisite_change_id,
        pullRequestNumber,
        source: row.source,
        actorGitHubUserId: row.actor_github_user_id,
        version: row.version,
        updatedAt: row.updated_at,
      } satisfies ChangeDependencyState
    })
    .filter((dependency): dependency is ChangeDependencyState => dependency !== null)
    .toSorted(
      (left, right) =>
        left.pullRequestNumber - right.pullRequestNumber ||
        left.changeId.localeCompare(right.changeId),
    )

  return {
    projectId: project.id,
    repositoryId,
    configurationVersion: project.configuration_version,
    dependentChangeId: dependent.id,
    dependentPullRequestNumber: dependent.pull_request_number,
    previousDependencies,
    previousDependencyChangeIds: previousTargetIds,
    previousDependencyPullRequestNumbers,
    desiredDependencies,
    nextVersion,
    graphChanged,
    commandKind,
  }
}

export async function prepareRemoveDependency(
  scope: RepositoryTransaction,
  command: RemoveDependency,
): Promise<PreparedDependencyMutation> {
  assertLocalId(command.dependencyChangeId, 'dependency change ID')

  const target = await scope.transaction
    .selectFrom('changes')
    .select('id')
    .where('project_id', '=', command.projectId)
    .where('id', '=', command.dependencyChangeId)
    .executeTakeFirst()

  if (!target) {
    throw new DependencyValidationError(
      'dependency_target_not_found',
      `Dependency change ${command.dependencyChangeId} does not exist in the current Project projection`,
      { details: { dependencyChangeId: command.dependencyChangeId } },
    )
  }

  const existing = await scope.transaction
    .selectFrom('change_dependencies')
    .select('prerequisite_change_id')
    .where('project_id', '=', command.projectId)
    .where('dependent_change_id', '=', command.changeId)
    .orderBy('prerequisite_change_id')
    .execute()

  return prepareSetDependencies(
    scope,
    {
      actorGitHubUserId: command.actorGitHubUserId,
      projectId: command.projectId,
      changeId: command.changeId,
      dependencyChangeIds: existing
        .map((row) => row.prerequisite_change_id)
        .filter((changeId) => changeId !== command.dependencyChangeId),
      source: 'user',
      correlationId: command.correlationId,
      ...(command.now === undefined ? {} : { now: command.now }),
    },
    'remove',
  )
}

export async function persistPreparedDependencyMutation(
  scope: RepositoryTransaction,
  command: SetDependencies,
  plan: PreparedDependencyMutation,
): Promise<DependencyMutationResult> {
  const repositoryId = assertRepositoryTransaction(scope, plan.repositoryId)
  const now = command.now ?? new Date()

  assertValidDate(now)

  if (!plan.graphChanged) {
    return {
      status: 'already_applied',
      dependentChangeId: plan.dependentChangeId,
      dependentPullRequestNumber: plan.dependentPullRequestNumber,
      dependencies: plan.previousDependencies,
      candidateReevaluation: null,
    }
  }

  const actorGitHubUserId = serializeNullableGitHubUserId(command.actorGitHubUserId)

  await scope.transaction
    .deleteFrom('change_dependencies')
    .where('project_id', '=', plan.projectId)
    .where('repository_id', '=', repositoryId)
    .where('dependent_change_id', '=', plan.dependentChangeId)
    .execute()

  if (plan.desiredDependencies.length > 0) {
    await scope.transaction
      .insertInto('change_dependencies')
      .values(
        plan.desiredDependencies.map((dependency) => ({
          project_id: plan.projectId,
          repository_id: repositoryId,
          dependent_change_id: plan.dependentChangeId,
          prerequisite_change_id: dependency.changeId,
          source: command.source,
          actor_github_user_id: actorGitHubUserId,
          comment: null,
          version: plan.nextVersion,
          created_at: now,
          updated_at: now,
        })),
      )
      .execute()
  }

  const candidateReevaluation = await touchProjectReleaseStateAndQueueEvaluation(scope, {
    projectId: plan.projectId,
    repositoryId,
    reason: 'dependencies_changed',
    now,
  })
  const dependencies: readonly ChangeDependencyState[] = plan.desiredDependencies.map(
    (dependency) => ({
      changeId: dependency.changeId,
      pullRequestNumber: dependency.pullRequestNumber,
      source: command.source,
      actorGitHubUserId,
      version: plan.nextVersion,
      updatedAt: now,
    }),
  )
  const beforeState: JsonValue = {
    dependencyChangeIds: plan.previousDependencyChangeIds,
    dependencyPullRequestNumbers: plan.previousDependencyPullRequestNumbers,
  }
  const afterState: JsonValue = {
    dependencyChangeIds: dependencies.map((dependency) => dependency.changeId),
    dependencyPullRequestNumbers: dependencies.map((dependency) => dependency.pullRequestNumber),
  }
  const eventType = 'dependencies_changed' as const
  const reasonCode =
    plan.commandKind === 'import'
      ? 'dependency_managed_block_imported'
      : plan.commandKind === 'remove'
        ? 'dependency_removed'
        : 'dependencies_set'
  const payload: JsonValue = {
    dependentChangeId: plan.dependentChangeId,
    dependentPullRequestNumber: plan.dependentPullRequestNumber,
    source: command.source,
    candidateReevaluation:
      candidateReevaluation === null
        ? null
        : {
            candidateId: candidateReevaluation.candidateId,
            candidateVersion: candidateReevaluation.candidateVersion,
          },
  }

  await scope.transaction
    .insertInto('audit_events')
    .values({
      id: randomUUID(),
      project_id: plan.projectId,
      repository_id: repositoryId,
      actor_github_user_id: actorGitHubUserId,
      event_type: eventType,
      source: command.source === 'user' ? 'user' : 'webhook',
      configuration_version: plan.configurationVersion,
      entity_type: 'dependency',
      entity_id: plan.dependentChangeId,
      correlation_id: command.correlationId,
      reason_code: reasonCode,
      before_state: JSON.stringify(beforeState),
      after_state: JSON.stringify(afterState),
      payload: JSON.stringify(payload),
      occurred_at: now,
    })
    .execute()

  return {
    status: 'recorded',
    dependentChangeId: plan.dependentChangeId,
    dependentPullRequestNumber: plan.dependentPullRequestNumber,
    dependencies,
    candidateReevaluation,
  }
}

export async function importDependenciesFromPullRequestWebhook(
  database: DatabaseClient,
  execution: GitHubWebhookProjectionExecution,
): Promise<void> {
  const executionRecord = execution as unknown as Readonly<Record<string, unknown>>
  const payload = parseWebhookPayload(
    executionRecord.payload ??
      executionRecord.webhookPayload ??
      executionRecord.rawPayload ??
      executionRecord.body,
  )

  if (!payload) {
    return
  }

  const event = getString(executionRecord.event) ?? getString(payload.event)
  const action = getString(executionRecord.action) ?? getString(payload.action)

  if (event !== 'pull_request' || action !== 'edited') {
    return
  }

  const changes = getRecord(payload.changes)

  if (!changes || !Object.hasOwn(changes, 'body')) {
    return
  }

  const repository = getRecord(payload.repository)
  const pullRequest = getRecord(payload.pull_request)
  const sender = getRecord(payload.sender)
  const repositoryId = getGitHubId(executionRecord.repositoryId) ?? getGitHubId(repository?.id)
  const pullRequestNumber =
    getPositiveInteger(payload.number) ?? getPositiveInteger(pullRequest?.number)
  const actorGitHubUserId = getPositiveInteger(sender?.id) ?? null
  const bodyValue = pullRequest?.body

  if (typeof bodyValue !== 'string' && bodyValue !== null) {
    return
  }

  const body = bodyValue
  const deliveryId =
    getString(executionRecord.deliveryId) ??
    getString(executionRecord.delivery_id) ??
    createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const correlationId = normalizeCorrelationId(
    getString(executionRecord.correlationId) ?? `github-webhook:${deliveryId}`,
  )

  if (!repositoryId || !pullRequestNumber) {
    return
  }

  const project = await database.kysely
    .selectFrom('projects')
    .select(['id', 'repository_id'])
    .where('repository_id', '=', repositoryId)
    .where('status', '<>', 'deleted')
    .orderBy('created_at')
    .executeTakeFirst()

  if (!project) {
    return
  }

  const dependent = await database.kysely
    .selectFrom('changes')
    .select('id')
    .where('project_id', '=', project.id)
    .where('repository_id', '=', repositoryId)
    .where('pull_request_number', '=', pullRequestNumber)
    .executeTakeFirst()

  if (!dependent) {
    return
  }

  const parsed = parseManagedDependencyBlock(body)

  if (parsed.status === 'invalid') {
    await withRepositoryTransaction(database, parseStoredGitHubId(repositoryId), async (scope) =>
      recordDependencyImportIssue(scope, {
        projectId: project.id,
        repositoryId,
        entityId: dependent.id,
        pullRequestNumber,
        deliveryId,
        code: parsed.code,
        message: parsed.message,
        body,
        payload: { pullRequestNumbers: [] },
      }),
    )
    return
  }

  try {
    await withRepositoryTransaction(database, parseStoredGitHubId(repositoryId), async (scope) => {
      const targets =
        parsed.pullRequestNumbers.length === 0
          ? []
          : await scope.transaction
              .selectFrom('changes')
              .select(['id', 'pull_request_number'])
              .where('project_id', '=', project.id)
              .where('repository_id', '=', repositoryId)
              .where('pull_request_number', 'in', parsed.pullRequestNumbers)
              .execute()
      const targetsByNumber = new Map(
        targets.map((target) => [target.pull_request_number, target.id] as const),
      )

      for (const targetPullRequestNumber of parsed.pullRequestNumbers) {
        if (!targetsByNumber.has(targetPullRequestNumber)) {
          throw new DependencyValidationError(
            'dependency_target_not_found',
            `Dependency pull request #${targetPullRequestNumber} does not exist in the current Project projection`,
            { details: { pullRequestNumber: targetPullRequestNumber } },
          )
        }
      }

      const command: SetDependencies = {
        actorGitHubUserId,
        projectId: project.id,
        changeId: dependent.id,
        dependencyChangeIds: parsed.pullRequestNumbers.map((number) => {
          const changeId = targetsByNumber.get(number)

          if (!changeId) {
            throw new Error(`Validated dependency pull request #${number} disappeared`)
          }

          return changeId
        }),
        source: 'managed_pr_body',
        correlationId,
      }
      const plan = await prepareSetDependencies(scope, command, 'import')
      await persistPreparedDependencyMutation(scope, command, plan)
    })
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      return
    }

    if (!(error instanceof DependencyValidationError) && !(error instanceof ChangeNotFoundError)) {
      throw error
    }

    await withRepositoryTransaction(database, parseStoredGitHubId(repositoryId), async (scope) =>
      recordDependencyImportIssue(scope, {
        projectId: project.id,
        repositoryId,
        entityId: dependent.id,
        pullRequestNumber,
        deliveryId,
        code:
          error instanceof DependencyValidationError ? error.code : 'dependency_target_not_found',
        message: error.message,
        body,
        payload: { pullRequestNumbers: parsed.pullRequestNumbers },
      }),
    )
  }
}

async function recordDependencyImportIssue(
  scope: RepositoryTransaction,
  input: {
    readonly projectId: string
    readonly repositoryId: string
    readonly entityId: string
    readonly pullRequestNumber: number
    readonly deliveryId: string
    readonly code: string
    readonly message: string
    readonly body: string | null
    readonly payload: JsonValue
  },
): Promise<void> {
  const repositoryId = assertRepositoryTransaction(scope, input.repositoryId)
  const issueId = randomUUID()
  const bodyHash = createHash('sha256')
    .update(input.body ?? '')
    .digest('hex')
  const payload = JSON.stringify(input.payload)

  await sql`
    insert into release_planning_issues (
      id,
      project_id,
      repository_id,
      category,
      entity_type,
      entity_id,
      pull_request_number,
      code,
      message,
      body_hash,
      source,
      source_reference,
      payload,
      created_at
    ) values (
      ${issueId},
      ${input.projectId},
      ${repositoryId},
      'dependency_managed_block',
      'change',
      ${input.entityId},
      ${input.pullRequestNumber},
      ${input.code},
      ${input.message},
      ${bodyHash},
      'github_webhook',
      ${input.deliveryId},
      ${payload}::jsonb,
      now()
    )
    on conflict (project_id, category, source_reference) do nothing
  `.execute(scope.transaction)
}

function normalizeChangeIds(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => {
    assertLocalId(value, 'dependency change ID')
    return value
  })

  return [...new Set(normalized)].toSorted()
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function serializeNullableGitHubUserId(value: number | null): string | null {
  if (value === null) {
    return null
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('actor GitHub user ID must be a positive safe integer or null')
  }

  return String(value)
}

function parseWebhookPayload(value: unknown): Readonly<Record<string, unknown>> | null {
  if (Buffer.isBuffer(value)) {
    return parseWebhookPayload(value.toString('utf8'))
  }

  if (typeof value === 'string') {
    try {
      return getRecord(JSON.parse(value))
    } catch {
      return null
    }
  }

  return getRecord(value)
}

function getRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function getPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value

  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function getGitHubId(value: unknown): string | null {
  const parsed = getPositiveInteger(value)
  return parsed === null ? null : String(parsed)
}

function parseStoredGitHubId(value: string): number {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Stored GitHub repository ID is outside the safe integer range: ${value}`)
  }

  return parsed
}

function normalizeCorrelationId(value: string): string {
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    return value
  }

  return createHash('sha256').update(value).digest('hex')
}

function assertLocalId(value: string, name: string): void {
  if (value.trim().length === 0 || value.length > 128) {
    throw new TypeError(`${name} must contain 1-128 characters`)
  }
}

function assertCorrelationId(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new TypeError('correlation ID is invalid')
  }
}

function assertValidDate(value: Date): void {
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('Dependency mutation timestamp is invalid')
  }
}
