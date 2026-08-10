import type {
  ProjectCheckState,
  ProjectHealthState,
  ProjectStatus,
  ProjectSynchronizationSummary,
} from '@/api/projects'
import { Badge } from '@/components/ui/badge'
import {
  checkStateLabel,
  productionPresenceLabel,
  projectHealthLabel,
  projectStatusLabel,
  synchronizationStatusLabel,
} from '@/lib/project-format'

export function ProjectStatusBadge({ status }: { readonly status: ProjectStatus }) {
  const variant =
    status === 'active'
      ? 'default'
      : status === 'degraded' || status === 'disconnected' || status === 'deleted'
        ? 'destructive'
        : status === 'pending_deletion'
          ? 'outline'
          : 'secondary'

  return <Badge variant={variant}>{projectStatusLabel(status)}</Badge>
}

export function ProjectHealthBadge({ state }: { readonly state: ProjectHealthState }) {
  const variant =
    state === 'healthy'
      ? 'default'
      : state === 'degraded' || state === 'disconnected'
        ? 'destructive'
        : state === 'deleting'
          ? 'outline'
          : 'secondary'

  return <Badge variant={variant}>{projectHealthLabel(state)}</Badge>
}

export function CheckStateBadge({ state }: { readonly state: ProjectCheckState }) {
  const variant =
    state === 'successful'
      ? 'default'
      : state === 'failed' || state === 'missing' || state === 'unknown'
        ? 'destructive'
        : state === 'not_configured' || state === 'not_applicable'
          ? 'outline'
          : 'secondary'

  return <Badge variant={variant}>{checkStateLabel(state)}</Badge>
}

export function ProductionPresenceBadge({
  state,
}: {
  readonly state: 'unreleased' | 'partially_present' | 'unknown'
}) {
  const variant =
    state === 'unreleased' ? 'secondary' : state === 'partially_present' ? 'destructive' : 'outline'

  return <Badge variant={variant}>{productionPresenceLabel(state)}</Badge>
}

export function SynchronizationStatusBadge({
  state,
}: {
  readonly state: ProjectSynchronizationSummary['status']
}) {
  const variant =
    state === 'succeeded'
      ? 'default'
      : state === 'failed'
        ? 'destructive'
        : state === 'superseded'
          ? 'outline'
          : 'secondary'

  return <Badge variant={variant}>{synchronizationStatusLabel(state)}</Badge>
}
