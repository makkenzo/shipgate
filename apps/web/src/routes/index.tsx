import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { normalizeApiError } from '@/api/api-error'
import { getHealthOptions, getReadinessOptions } from '@/api/generated/@tanstack/react-query.gen'
import { StatusCard, type StatusState } from '@/components/status-card'
import { Badge } from '@/components/ui/badge'

export const Route = createFileRoute('/')({
  component: SystemStatusPage,
})

function SystemStatusPage() {
  const health = useQuery({
    ...getHealthOptions(),

    refetchInterval: 10_000,
  })

  const readiness = useQuery({
    ...getReadinessOptions(),

    refetchInterval: 10_000,
  })

  const apiState = getQueryState(health)

  const databaseState = getQueryState(readiness)

  const workerState = readiness.isPending
    ? 'loading'
    : readiness.isSuccess && readiness.data.checks.worker.activeWorkers > 0
      ? 'operational'
      : 'unavailable'

  const systemLoading = health.isPending || readiness.isPending

  const systemOperational =
    health.isSuccess &&
    readiness.isSuccess &&
    readiness.data.checks.worker.status === 'ok' &&
    readiness.data.checks.worker.activeWorkers > 0

  const healthError = health.error ? normalizeApiError(health.error) : undefined

  const readinessError = readiness.error ? normalizeApiError(readiness.error) : undefined

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">System status</h1>

          <p className="mt-2 text-muted-foreground">Current Shipgate infrastructure state.</p>
        </div>

        <Badge
          variant={systemOperational ? 'default' : systemLoading ? 'secondary' : 'destructive'}
        >
          {systemOperational
            ? 'All systems operational'
            : systemLoading
              ? 'Checking systems'
              : 'System degraded'}
        </Badge>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <StatusCard
          title="API status"
          state={apiState}
          description={healthError?.message ?? 'HTTP API process and routing.'}
        >
          {health.isSuccess ? (
            <>
              Version: {health.data.version}
              <br />
              Uptime: {health.data.uptimeSeconds}s
            </>
          ) : healthError?.requestId ? (
            <>Request ID: {healthError.requestId}</>
          ) : null}
        </StatusCard>

        <StatusCard
          title="Worker status"
          state={workerState}
          description={readinessError?.message ?? 'Durable background job worker.'}
        >
          {readiness.isSuccess ? (
            <>
              Active workers: {readiness.data.checks.worker.activeWorkers}
              <br />
              Stale workers: {readiness.data.checks.worker.staleWorkers}
            </>
          ) : null}
        </StatusCard>

        <StatusCard
          title="Database status"
          state={databaseState}
          description={readinessError?.message ?? 'PostgreSQL connectivity and readiness.'}
        >
          {readiness.isSuccess ? (
            <>
              Latency: {readiness.data.checks.database.latencyMs}
              ms
            </>
          ) : readinessError?.requestId ? (
            <>Request ID: {readinessError.requestId}</>
          ) : null}
        </StatusCard>
      </div>
    </main>
  )
}

function getQueryState(query: {
  readonly isPending: boolean
  readonly isSuccess: boolean
}): StatusState {
  if (query.isPending) {
    return 'loading'
  }

  return query.isSuccess ? 'operational' : 'unavailable'
}
