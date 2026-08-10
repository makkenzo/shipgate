import type {
  ProjectCheckState,
  ProjectHealthState,
  ProjectStatus,
  ProjectSynchronizationSummary,
} from '@/api/projects'

export function shortSha(value: string | null): string {
  return value?.slice(0, 8) ?? 'not observed'
}

export function formatDateTime(value: string | null): string {
  if (!value) return '—'

  const date = new Date(value)

  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
}

export function formatDuration(value: number | null): string {
  if (value === null) return 'In progress'
  if (value < 1_000) return `${value} ms`

  const seconds = Math.round(value / 1_000)
  if (seconds < 60) return `${seconds} s`

  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}m ${remainder}s`
}

export function formatReason(reason: string): string {
  return reason
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (value) => value.toUpperCase())
}

export function projectStatusLabel(status: ProjectStatus): string {
  switch (status) {
    case 'initializing':
      return 'Initializing'
    case 'active':
      return 'Active'
    case 'degraded':
      return 'Degraded'
    case 'disconnected':
      return 'Disconnected'
    case 'pending_deletion':
      return 'Removing'
    case 'deleted':
      return 'Deleted'
  }
}

export function projectHealthLabel(state: ProjectHealthState): string {
  switch (state) {
    case 'healthy':
      return 'Healthy'
    case 'attention':
      return 'Needs attention'
    case 'initializing':
      return 'Initializing'
    case 'synchronizing':
      return 'Synchronizing'
    case 'degraded':
      return 'Degraded'
    case 'disconnected':
      return 'Disconnected'
    case 'deleting':
      return 'Removing'
  }
}

export function checkStateLabel(state: ProjectCheckState): string {
  switch (state) {
    case 'not_configured':
      return 'No required checks'
    case 'not_applicable':
      return 'Not applicable'
    case 'successful':
      return 'Passing'
    case 'pending':
      return 'Pending'
    case 'failed':
      return 'Failed'
    case 'missing':
      return 'Missing'
    case 'stale':
      return 'Stale'
    case 'unknown':
      return 'Unknown'
  }
}

export function productionPresenceLabel(
  state: 'unreleased' | 'partially_present' | 'unknown',
): string {
  switch (state) {
    case 'unreleased':
      return 'Unreleased'
    case 'partially_present':
      return 'Partially present'
    case 'unknown':
      return 'Unknown'
  }
}

export function synchronizationStatusLabel(state: ProjectSynchronizationSummary['status']): string {
  switch (state) {
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Running'
    case 'succeeded':
      return 'Succeeded'
    case 'superseded':
      return 'Superseded'
    case 'failed':
      return 'Failed'
  }
}
