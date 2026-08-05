import { describe, expect, it } from 'vitest'

import { ApiHttpError } from '../http/api-error.js'
import { parseGitHubWebhookMetadata } from './policy.js'

describe('GitHub webhook action policy', () => {
  it('accepts a known event with a future action as an ignored delivery', () => {
    expect(
      parseGitHubWebhookMetadata('pull_request', {
        action: 'future_action_added_by_github',
        installation: { id: 12 },
        repository: { id: 34 },
      }),
    ).toEqual({
      event: 'pull_request',
      action: 'future_action_added_by_github',
      installationId: '12',
      repositoryId: '34',
      actionSupported: false,
      ignoredReason: 'unsupported_action',
    })
  })

  it('rejects a missing action for an action-based event as malformed', () => {
    expect(() =>
      parseGitHubWebhookMetadata('pull_request', {
        installation: { id: 12 },
        repository: { id: 34 },
      }),
    ).toThrow(ApiHttpError)
  })

  it('keeps actionless push deliveries runnable', () => {
    expect(parseGitHubWebhookMetadata('push', { repository: { id: 34 } })).toMatchObject({
      event: 'push',
      action: null,
      actionSupported: true,
      ignoredReason: null,
    })
  })

  it('still rejects webhook event types that the GitHub App did not subscribe to', () => {
    expect(() => parseGitHubWebhookMetadata('future_event', {})).toThrow(ApiHttpError)
  })
})
