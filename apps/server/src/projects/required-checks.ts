import type { InstallationGitHubClient, InstallationPermissions } from '@shipgate/github'

import { ProjectConfigurationValidationError } from './errors.js'
import type {
  CommitCheckResultProjection,
  RequiredCheckObservation,
  RequiredCheckOverride,
  RequiredCheckProjection,
  RequiredCheckState,
} from './model.js'

export type { RequiredCheckOverride } from './model.js'

const pageSize = 100
const maximumPages = 100
const requiredCheckFreshnessMs = 7 * 24 * 60 * 60_000

const permissions = {
  metadata: 'read',
  checks: 'read',
  statuses: 'read',
  administration: 'read',
} as const satisfies InstallationPermissions

export interface RequiredCheckRepositoryIdentity {
  readonly ownerLogin: string
  readonly name: string
}

export interface RequiredCheckResolution {
  readonly state: RequiredCheckState
  readonly observations: readonly RequiredCheckObservation[]
}

export async function loadEffectiveRequiredChecks(input: {
  readonly client: InstallationGitHubClient
  readonly repository: RequiredCheckRepositoryIdentity
  readonly sourceBranch: string
  readonly overrides: readonly RequiredCheckOverride[]
}): Promise<readonly RequiredCheckProjection[]> {
  const checks = new Map<string, RequiredCheckProjection>()

  await loadClassicBranchProtection(input, checks)
  await loadActiveRules(input, checks)

  for (const override of input.overrides) {
    addRequiredCheck(checks, {
      context: normalizeContext(override.context),
      integrationId: normalizeNullableIntegrationId(override.integrationId),
      source: 'project_override',
      sourceReference: null,
    })
  }

  return [...checks.values()].toSorted(compareRequiredChecks)
}

export async function loadCheckResultsForCommit(input: {
  readonly client: InstallationGitHubClient
  readonly repository: RequiredCheckRepositoryIdentity
  readonly commitSha: string
  readonly observedAt: Date
}): Promise<readonly CommitCheckResultProjection[]> {
  const commitSha = normalizeSha(input.commitSha, 'required-check target SHA')
  const results: CommitCheckResultProjection[] = []

  let checkRunsComplete = false

  for (let page = 1; page <= maximumPages; page += 1) {
    const response = await input.client.request(
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      {
        owner: input.repository.ownerLogin,
        repo: input.repository.name,
        ref: commitSha,
        per_page: pageSize,
        page,
        filter: 'all',
      },
    )
    const body = requireRecord(response.data, 'check runs response')
    const items = Array.isArray(body.check_runs) ? body.check_runs : []

    for (const item of items) {
      const check = requireRecord(item, 'check run')
      const advertisedHeadSha = nullableSha(check.head_sha)

      if (advertisedHeadSha !== null && advertisedHeadSha !== commitSha) {
        throw new ProjectConfigurationValidationError(
          'external_state_unknown',
          `GitHub returned check run ${String(check.id)} for ${advertisedHeadSha}, expected ${commitSha}`,
        )
      }

      const app = isRecord(check.app) ? check.app : undefined
      const startedAt = nullableDate(check.started_at)
      const completedAt = nullableDate(check.completed_at)

      results.push({
        commitSha,
        type: 'check_run',
        context: normalizeContext(requireString(check.name, 'check run name')),
        integrationId: app ? nullablePositiveInteger(app.id) : null,
        githubObjectId: requirePositiveInteger(check.id, 'check run ID'),
        attempt: nullablePositiveInteger(check.run_attempt),
        status: normalizeCheckRunStatus(check.status),
        conclusion: normalizeCheckConclusion(check.conclusion),
        detailsUrl: nullableString(check.details_url),
        startedAt,
        completedAt,
        observedAt: input.observedAt,
      })
    }

    if (items.length < pageSize) {
      checkRunsComplete = true
      break
    }
  }

  if (!checkRunsComplete) {
    throw incompletePaginationError(`check runs for ${commitSha}`)
  }

  let statusesComplete = false

  for (let page = 1; page <= maximumPages; page += 1) {
    const response = await input.client.request(
      'GET /repos/{owner}/{repo}/commits/{ref}/statuses',
      {
        owner: input.repository.ownerLogin,
        repo: input.repository.name,
        ref: commitSha,
        per_page: pageSize,
        page,
      },
    )
    const items = requireArray(response.data, 'commit statuses response')

    for (const item of items) {
      const status = requireRecord(item, 'commit status')
      const advertisedSha = nullableSha(status.sha)

      if (advertisedSha !== null && advertisedSha !== commitSha) {
        throw new ProjectConfigurationValidationError(
          'external_state_unknown',
          `GitHub returned commit status ${String(status.id)} for ${advertisedSha}, expected ${commitSha}`,
        )
      }

      const state = requireString(status.state, 'commit status state')
      const startedAt = nullableDate(status.created_at)
      const updatedAt = nullableDate(status.updated_at)

      results.push({
        commitSha,
        type: 'commit_status',
        context: normalizeContext(requireString(status.context, 'commit status context')),
        integrationId: null,
        githubObjectId: requirePositiveInteger(status.id, 'commit status ID'),
        attempt: null,
        status: state === 'pending' ? 'pending' : 'completed',
        conclusion: normalizeCommitStatusConclusion(state),
        detailsUrl: nullableString(status.target_url),
        startedAt,
        completedAt: state === 'pending' ? null : (updatedAt ?? startedAt),
        observedAt: input.observedAt,
      })
    }

    if (items.length < pageSize) {
      statusesComplete = true
      break
    }
  }

  if (!statusesComplete) {
    throw incompletePaginationError(`commit statuses for ${commitSha}`)
  }

  return deduplicateByGitHubIdentity(results)
}

export function resolveRequiredCheck(
  requirement: Pick<RequiredCheckProjection, 'context' | 'integrationId'>,
  observations: readonly CommitCheckResultProjection[],
): RequiredCheckResolution {
  const matching = observations.filter((observation) => {
    if (observation.context !== requirement.context) {
      return false
    }

    if (requirement.integrationId === null) {
      return true
    }

    return (
      observation.type === 'check_run' &&
      normalizeNullableIntegrationId(observation.integrationId) === requirement.integrationId
    )
  })

  const authoritative = selectAuthoritativeObservations(matching)

  if (authoritative.length === 0) {
    return { state: 'missing', observations: [] }
  }

  if (authoritative.some(isFailedObservation)) {
    return { state: 'failed', observations: authoritative }
  }

  if (authoritative.some(isStaleObservation)) {
    return { state: 'stale', observations: authoritative }
  }

  if (authoritative.some((observation) => observation.status !== 'completed')) {
    return { state: 'pending', observations: authoritative }
  }

  return { state: 'successful', observations: authoritative }
}

export function parseRequiredCheckOverrides(value: unknown): readonly RequiredCheckOverride[] {
  if (!Array.isArray(value)) {
    throw new Error('Stored required-check overrides must be a JSON array')
  }

  const seen = new Set<string>()
  const overrides: RequiredCheckOverride[] = []

  for (const item of value) {
    const record = requireRecord(item, 'required-check override')
    const context = normalizeContext(
      requireString(record.context, 'required-check override context'),
    )
    const integrationId = normalizeNullableIntegrationId(record.integrationId)
    const key = `${context}\0${integrationId ?? ''}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    overrides.push({ context, integrationId })
  }

  return overrides.toSorted(compareOverrides)
}

export function normalizeRequiredCheckOverrides(
  overrides: readonly RequiredCheckOverride[],
): readonly RequiredCheckOverride[] {
  return parseRequiredCheckOverrides(overrides)
}

export { permissions as requiredChecksPermissions }

async function loadClassicBranchProtection(
  input: {
    readonly client: InstallationGitHubClient
    readonly repository: RequiredCheckRepositoryIdentity
    readonly sourceBranch: string
  },
  checks: Map<string, RequiredCheckProjection>,
): Promise<void> {
  try {
    const response = await input.client.request(
      'GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks',
      {
        owner: input.repository.ownerLogin,
        repo: input.repository.name,
        branch: input.sourceBranch,
      },
    )
    const value = requireRecord(response.data, 'required status checks')
    const structuredContexts = new Set<string>()

    for (const item of Array.isArray(value.checks) ? value.checks : []) {
      const check = requireRecord(item, 'required branch check')
      const context = normalizeContext(
        requireString(check.context, 'required branch check context'),
      )
      structuredContexts.add(context)
      addRequiredCheck(checks, {
        context,
        integrationId: nullablePositiveInteger(check.app_id),
        source: 'branch_protection',
        sourceReference: input.sourceBranch,
      })
    }

    for (const contextValue of Array.isArray(value.contexts) ? value.contexts : []) {
      if (typeof contextValue !== 'string') {
        continue
      }

      const context = normalizeContext(contextValue)

      if (!structuredContexts.has(context)) {
        addRequiredCheck(checks, {
          context,
          integrationId: null,
          source: 'branch_protection',
          sourceReference: input.sourceBranch,
        })
      }
    }
  } catch (error) {
    if (getStatus(error) !== 404) {
      throw error
    }
  }
}

async function loadActiveRules(
  input: {
    readonly client: InstallationGitHubClient
    readonly repository: RequiredCheckRepositoryIdentity
    readonly sourceBranch: string
  },
  checks: Map<string, RequiredCheckProjection>,
): Promise<void> {
  let complete = false

  try {
    for (let page = 1; page <= maximumPages; page += 1) {
      const response = await input.client.request(
        'GET /repos/{owner}/{repo}/rules/branches/{branch}',
        {
          owner: input.repository.ownerLogin,
          repo: input.repository.name,
          branch: input.sourceBranch,
          per_page: pageSize,
          page,
        },
      )
      const rules = requireArray(response.data, 'active branch rules')

      for (const item of rules) {
        const rule = requireRecord(item, 'active branch rule')

        if (rule.type !== 'required_status_checks') {
          continue
        }

        const parameters = requireRecord(rule.parameters, 'required status checks parameters')
        const rulesetId = requirePositiveInteger(rule.ruleset_id, 'repository ruleset ID')
        const sourceReference = createRulesetSourceReference(rule, rulesetId)

        for (const requiredItem of Array.isArray(parameters.required_status_checks)
          ? parameters.required_status_checks
          : []) {
          const required = requireRecord(requiredItem, 'ruleset required check')
          addRequiredCheck(checks, {
            context: normalizeContext(
              requireString(required.context, 'ruleset required check context'),
            ),
            integrationId: nullablePositiveInteger(required.integration_id),
            source: 'repository_ruleset',
            sourceReference,
          })
        }
      }

      if (rules.length < pageSize) {
        complete = true
        break
      }
    }
  } catch (error) {
    if (getStatus(error) === 404) {
      return
    }

    throw error
  }

  if (!complete) {
    throw incompletePaginationError(`active rules for branch ${input.sourceBranch}`)
  }
}

function createRulesetSourceReference(
  rule: Readonly<Record<string, unknown>>,
  rulesetId: number,
): string {
  const sourceType = typeof rule.ruleset_source_type === 'string' ? rule.ruleset_source_type : null
  const source = typeof rule.ruleset_source === 'string' ? rule.ruleset_source : null

  return [sourceType, source, String(rulesetId)].filter((value) => value !== null).join(':')
}

function selectAuthoritativeObservations(
  observations: readonly CommitCheckResultProjection[],
): readonly RequiredCheckObservation[] {
  const latestCheckRun = observations
    .filter((observation) => observation.type === 'check_run')
    .toSorted(compareObservationRecency)
    .at(-1)
  const latestCommitStatus = observations
    .filter((observation) => observation.type === 'commit_status')
    .toSorted(compareObservationRecency)
    .at(-1)

  return [latestCheckRun, latestCommitStatus]
    .filter((observation): observation is CommitCheckResultProjection => observation !== undefined)
    .map(toRequiredCheckObservation)
    .toSorted((left, right) => left.type.localeCompare(right.type))
}

function toRequiredCheckObservation(
  observation: CommitCheckResultProjection,
): RequiredCheckObservation {
  return {
    id: observation.id ?? null,
    type: observation.type,
    integrationId: observation.integrationId === null ? null : Number(observation.integrationId),
    githubObjectId: String(observation.githubObjectId),
    attempt: observation.attempt,
    status: observation.status,
    conclusion: observation.conclusion,
    detailsUrl: observation.detailsUrl,
    startedAt: observation.startedAt,
    completedAt: observation.completedAt,
    observedAt: observation.observedAt,
  }
}

function compareObservationRecency(
  left: CommitCheckResultProjection,
  right: CommitCheckResultProjection,
): number {
  return (
    observationTimestamp(left) - observationTimestamp(right) ||
    (left.attempt ?? 0) - (right.attempt ?? 0) ||
    compareNumericIdentity(left.githubObjectId, right.githubObjectId)
  )
}

function observationTimestamp(observation: CommitCheckResultProjection): number {
  return (
    observation.startedAt?.getTime() ??
    observation.completedAt?.getTime() ??
    observation.observedAt.getTime()
  )
}

function isFailedObservation(observation: RequiredCheckObservation): boolean {
  return (
    observation.status === 'completed' &&
    observation.conclusion !== 'stale' &&
    !isSuccessfulConclusion(observation.conclusion)
  )
}

function isStaleObservation(observation: RequiredCheckObservation): boolean {
  if (observation.conclusion === 'stale') {
    return true
  }

  if (observation.status !== 'completed' || !isSuccessfulConclusion(observation.conclusion)) {
    return false
  }

  const completedAt = observation.completedAt ?? observation.startedAt

  return (
    completedAt === null ||
    completedAt.getTime() < observation.observedAt.getTime() - requiredCheckFreshnessMs
  )
}

function compareNumericIdentity(left: number | string, right: number | string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function isSuccessfulConclusion(conclusion: CommitCheckResultProjection['conclusion']): boolean {
  return conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped'
}

function deduplicateByGitHubIdentity(
  results: readonly CommitCheckResultProjection[],
): readonly CommitCheckResultProjection[] {
  const seen = new Set<string>()
  const deduplicated: CommitCheckResultProjection[] = []

  for (const result of results) {
    const key = [result.type, result.githubObjectId, result.attempt ?? ''].join(':')

    if (!seen.has(key)) {
      seen.add(key)
      deduplicated.push(result)
    }
  }

  return deduplicated
}

function addRequiredCheck(
  target: Map<string, RequiredCheckProjection>,
  check: RequiredCheckProjection,
): void {
  const key = [check.context, check.integrationId ?? ''].join('\0')
  const existing = target.get(key)

  if (!existing || compareSourcePriority(check, existing) > 0) {
    target.set(key, check)
  }
}

function compareSourcePriority(
  left: RequiredCheckProjection,
  right: RequiredCheckProjection,
): number {
  return (
    getSourcePriority(left.source) - getSourcePriority(right.source) ||
    (right.sourceReference ?? '').localeCompare(left.sourceReference ?? '')
  )
}

function getSourcePriority(source: RequiredCheckProjection['source']): number {
  switch (source) {
    case 'branch_protection':
      return 1
    case 'repository_ruleset':
      return 2
    case 'project_override':
      return 3
  }
}

function compareRequiredChecks(
  left: RequiredCheckProjection,
  right: RequiredCheckProjection,
): number {
  return (
    left.context.localeCompare(right.context) ||
    (left.integrationId ?? 0) - (right.integrationId ?? 0) ||
    left.source.localeCompare(right.source) ||
    (left.sourceReference ?? '').localeCompare(right.sourceReference ?? '')
  )
}

function compareOverrides(left: RequiredCheckOverride, right: RequiredCheckOverride): number {
  return (
    left.context.localeCompare(right.context) ||
    (left.integrationId ?? 0) - (right.integrationId ?? 0)
  )
}

function normalizeContext(value: string): string {
  const context = value.trim()

  if (
    context.length === 0 ||
    context.length > 255 ||
    context.includes('\r') ||
    context.includes('\n') ||
    context.includes('\u0000')
  ) {
    throw new TypeError('Required-check context must be 1-255 safe characters')
  }

  return context
}

function normalizeNullableIntegrationId(value: unknown): number | null {
  if (value === null || value === undefined || value === -1) {
    return null
  }

  const parsed = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value

  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError('Required-check integration ID must be a positive safe integer or null')
  }

  return parsed
}

function normalizeCheckRunStatus(value: unknown): CommitCheckResultProjection['status'] {
  switch (value) {
    case 'queued':
    case 'requested':
    case 'waiting':
      return 'queued'
    case 'in_progress':
      return 'in_progress'
    case 'pending':
      return 'pending'
    case 'completed':
      return 'completed'
    default:
      throw new Error(`Unsupported GitHub check run status: ${String(value)}`)
  }
}

function normalizeCheckConclusion(value: unknown): CommitCheckResultProjection['conclusion'] {
  const accepted = new Set([
    'success',
    'failure',
    'neutral',
    'cancelled',
    'skipped',
    'timed_out',
    'action_required',
    'stale',
    'startup_failure',
    'error',
  ])

  return typeof value === 'string' && accepted.has(value)
    ? (value as Exclude<CommitCheckResultProjection['conclusion'], null>)
    : null
}

function normalizeCommitStatusConclusion(state: string): CommitCheckResultProjection['conclusion'] {
  switch (state) {
    case 'pending':
      return null
    case 'success':
      return 'success'
    case 'failure':
      return 'failure'
    case 'error':
      return 'error'
    default:
      throw new Error(`Unsupported GitHub commit status state: ${state}`)
  }
}

function incompletePaginationError(resource: string): ProjectConfigurationValidationError {
  return new ProjectConfigurationValidationError(
    'external_state_unknown',
    `GitHub pagination limit was exceeded while loading ${resource}`,
    { details: { maximumPages, pageSize } },
  )
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} is not an object`)
  }

  return value
}

function requireArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} is not an array`)
  }

  return value
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is invalid`)
  }

  return value
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} is invalid`)
  }

  return value
}

function nullablePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function normalizeSha(value: string, name: string): string {
  const sha = value.toLowerCase()

  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`${name} is invalid`)
  }

  return sha
}

function nullableSha(value: unknown): string | null {
  return typeof value === 'string' ? normalizeSha(value, 'GitHub commit SHA') : null
}

function nullableDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function getStatus(value: unknown): number | undefined {
  return isRecord(value) && typeof value.status === 'number' ? value.status : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
