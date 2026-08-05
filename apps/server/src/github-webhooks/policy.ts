import type { GITHUB_APP_EVENTS } from '@shipgate/github'
import { ApiHttpError } from '../http/api-error.js'

type Event = (typeof GITHUB_APP_EVENTS)[number] | 'ping'

const actions = {
  ping: null,
  push: null,
  status: null,
  pull_request: [
    'assigned',
    'auto_merge_disabled',
    'auto_merge_enabled',
    'closed',
    'converted_to_draft',
    'dequeued',
    'demilestoned',
    'edited',
    'enqueued',
    'labeled',
    'locked',
    'milestoned',
    'opened',
    'ready_for_review',
    'reopened',
    'review_request_removed',
    'review_requested',
    'synchronize',
    'unassigned',
    'unlabeled',
    'unlocked',
  ],
  check_run: ['completed', 'created', 'rerequested', 'requested_action'],
  repository: [
    'archived',
    'created',
    'deleted',
    'edited',
    'privatized',
    'publicized',
    'renamed',
    'transferred',
    'unarchived',
  ],
  branch_protection_rule: ['created', 'deleted', 'edited'],
  repository_ruleset: ['created', 'deleted', 'edited'],
  installation: ['created', 'deleted', 'new_permissions_accepted', 'suspend', 'unsuspend'],
  installation_repositories: ['added', 'removed'],
  github_app_authorization: ['revoked'],
} as const satisfies Readonly<Record<Event, readonly string[] | null>>
export type AllowedGitHubWebhookEvent = keyof typeof actions
export interface GitHubWebhookMetadata {
  readonly event: AllowedGitHubWebhookEvent
  readonly action: string | null
  readonly installationId: string | null
  readonly repositoryId: string | null
  readonly actionSupported: boolean
  readonly ignoredReason: string | null
}
export function assertGitHubWebhookEventAllowed(
  event: string,
): asserts event is AllowedGitHubWebhookEvent {
  if (!Object.hasOwn(actions, event))
    throw new ApiHttpError({
      statusCode: 422,
      code: 'GITHUB_WEBHOOK_EVENT_NOT_ALLOWED',
      message: 'GitHub webhook event is not allowed',
      details: { event },
    })
}
export function parseGitHubWebhookMetadata(
  eventValue: string,
  payload: unknown,
): GitHubWebhookMetadata {
  assertGitHubWebhookEventAllowed(eventValue)
  if (!isRecord(payload))
    throw new ApiHttpError({
      statusCode: 400,
      code: 'INVALID_GITHUB_WEBHOOK_PAYLOAD',
      message: 'GitHub webhook payload must be a JSON object',
    })
  const allowed = actions[eventValue]
  const actionValue = payload.action

  if (
    (allowed !== null && typeof actionValue !== 'string') ||
    (allowed === null && actionValue !== undefined && typeof actionValue !== 'string')
  ) {
    throw new ApiHttpError({
      statusCode: 400,
      code: 'INVALID_GITHUB_WEBHOOK_PAYLOAD',
      message: 'GitHub webhook action must be a string when present',
    })
  }

  const action = typeof actionValue === 'string' ? actionValue : null
  const actionSupported =
    allowed === null
      ? actionValue === undefined
      : (allowed as readonly string[]).includes(action as string)

  return {
    event: eventValue,
    action,
    installationId: readId(payload.installation),
    repositoryId: readId(payload.repository),
    actionSupported,
    ignoredReason: actionSupported ? null : 'unsupported_action',
  }
}
function readId(value: unknown): string | null {
  if (value == null) return null
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0
  )
    throw new ApiHttpError({
      statusCode: 400,
      code: 'INVALID_GITHUB_WEBHOOK_PAYLOAD',
      message: 'GitHub webhook identity is invalid',
    })
  return String(value.id)
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
