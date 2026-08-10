import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'

import {
  projectKeys,
  projectOverviewOptions,
  projectSynchronizationOptions,
} from '@/api/project-queries'
import { reconcileProject } from '@/api/projects'
import { SynchronizationStatusBadge } from '@/components/project/project-badges'
import { ProjectShell } from '@/components/project/project-shell'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAuthenticatedRoute } from '@/lib/auth-route'
import { formatDateTime, formatDuration, formatReason, shortSha } from '@/lib/project-format'

export const Route = createFileRoute('/projects_/$projectId_/synchronization')({
  beforeLoad: ({ context }) => requireAuthenticatedRoute(context.queryClient),
  component: ProjectSynchronizationPage,
})

function ProjectSynchronizationPage() {
  const { projectId } = Route.useParams()
  const queryClient = useQueryClient()
  const overview = useQuery(projectOverviewOptions(projectId))
  const synchronization = useQuery(projectSynchronizationOptions(projectId))
  const mutation = useMutation({
    mutationFn: async () => {
      if (!overview.data) throw new Error('Project overview is not loaded')

      return reconcileProject(projectId, overview.data.project.configurationVersion)
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectKeys.overview(projectId) }),
        queryClient.invalidateQueries({ queryKey: projectKeys.synchronization(projectId) }),
        queryClient.invalidateQueries({ queryKey: projectKeys.changes(projectId) }),
        queryClient.invalidateQueries({ queryKey: projectKeys.list() }),
      ])
    },
  })

  if (overview.isError) throw overview.error
  if (synchronization.isError) throw synchronization.error
  if (!overview.data || !synchronization.data) return <PageLoading />

  const project = overview.data.project
  const activeRun = synchronization.data.runs.find(
    (run) => run.status === 'queued' || run.status === 'running',
  )
  const reconciliationUnavailable =
    activeRun !== undefined ||
    ['disconnected', 'pending_deletion', 'deleted'].includes(project.status) ||
    ['disconnected', 'deleting'].includes(overview.data.health.state) ||
    project.sourceSha === null ||
    project.productionSha === null

  return (
    <ProjectShell
      overview={overview.data}
      section="synchronization"
      actions={
        <Button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || reconciliationUnavailable}
        >
          <RefreshCw data-icon="inline-start" />
          {mutation.isPending ? 'Queueing…' : activeRun ? 'Reconciliation active' : 'Reconcile now'}
        </Button>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Projection health</CardTitle>
              <CardDescription>{synchronization.data.health.summary}</CardDescription>
            </CardHeader>
            <CardContent>
              {synchronization.data.health.reasons.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No degraded-state reason or synchronization warning is recorded.
                </p>
              ) : (
                <div className="grid gap-3">
                  {synchronization.data.health.reasons.map((reason) => (
                    <div
                      key={`${reason.code}:${reason.message}`}
                      className="rounded-lg border bg-muted/20 p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">{formatReason(reason.code)}</p>
                        <span className="text-xs text-muted-foreground">{reason.severity}</span>
                      </div>
                      <p className="mt-1 text-muted-foreground">{reason.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Manual reconciliation</CardTitle>
              <CardDescription>
                Compares the current GitHub state with the committed local projection and repairs
                recoverable drift.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                Reconciliation is coalesced with an already queued full run for the same project and
                configuration version.
              </p>
              {reconciliationUnavailable ? (
                <p className="rounded-lg border bg-muted/30 p-3">
                  {activeRun
                    ? 'A reconciliation is already queued or running.'
                    : 'Reconciliation is unavailable until GitHub access and both branch heads are current.'}
                </p>
              ) : null}
              {mutation.isError ? (
                <p className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-destructive">
                  {mutation.error instanceof Error
                    ? mutation.error.message
                    : 'Unable to queue reconciliation'}
                </p>
              ) : null}
              {mutation.isSuccess && mutation.data ? (
                <p className="rounded-lg border bg-muted/30 p-3 text-foreground">
                  Reconciliation request {mutation.data.requestId} is {mutation.data.status}.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Synchronization history</CardTitle>
            <CardDescription>
              Observed branch heads, duration, trigger reason and classified issues for each run.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {synchronization.data.runs.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No synchronization run has been recorded yet.
              </p>
            ) : (
              <div className="grid gap-4">
                {synchronization.data.runs.map((run) => (
                  <article key={run.id} className="rounded-xl border p-4">
                    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <SynchronizationStatusBadge state={run.status} />
                          <p className="font-medium">{formatReason(run.reason)}</p>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Requested {formatDateTime(run.requestedAt)} · started{' '}
                          {formatDateTime(run.startedAt)} · {formatDuration(run.durationMs)}
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <span className="text-muted-foreground">Source</span>
                        <code>{shortSha(run.sourceSha)}</code>
                        <span className="text-muted-foreground">Production</span>
                        <code>{shortSha(run.productionSha)}</code>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                      <span>
                        <span className="text-muted-foreground">Configuration:</span> v
                        {run.configurationVersion}
                      </span>
                      <span>
                        <span className="text-muted-foreground">Issues:</span> {run.issueCount}
                      </span>
                      {run.coalescedCount > 0 ? (
                        <span>
                          <span className="text-muted-foreground">Coalesced:</span>{' '}
                          {run.coalescedCount}
                        </span>
                      ) : null}
                      {run.forcePush ? (
                        <span className="text-destructive">Force push detected</span>
                      ) : null}
                    </div>

                    {run.classification ? (
                      <p className="mt-4 text-sm">
                        <span className="text-muted-foreground">Classification:</span>{' '}
                        {formatReason(run.classification)}
                      </p>
                    ) : null}

                    {run.errorMessage ? (
                      <p className="mt-3 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
                        {run.errorMessage}
                      </p>
                    ) : null}

                    {run.issues.length > 0 ? (
                      <div className="mt-4 grid gap-2">
                        {run.issues.map((issue) => (
                          <div key={issue.id} className="rounded-lg border bg-muted/20 p-3 text-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="font-medium">{formatReason(issue.code)}</p>
                              <span className="text-xs text-muted-foreground">
                                {issue.scope} · {issue.severity}
                              </span>
                            </div>
                            <p className="mt-1 text-muted-foreground">{issue.message}</p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </ProjectShell>
  )
}

function PageLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="h-96 animate-pulse rounded-xl bg-muted" />
    </main>
  )
}
