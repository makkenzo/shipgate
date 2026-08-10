import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowRight, CheckCircle2, GitCommit, GitPullRequest } from 'lucide-react'
import type { ReactNode } from 'react'

import { projectOverviewOptions } from '@/api/project-queries'
import { CheckStateBadge, SynchronizationStatusBadge } from '@/components/project/project-badges'
import { ProjectShell } from '@/components/project/project-shell'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAuthenticatedRoute } from '@/lib/auth-route'
import { formatDateTime, formatDuration, formatReason, shortSha } from '@/lib/project-format'

export const Route = createFileRoute('/projects_/$projectId')({
  beforeLoad: ({ context }) => requireAuthenticatedRoute(context.queryClient),
  component: ProjectOverviewPage,
})

function ProjectOverviewPage() {
  const { projectId } = Route.useParams()
  const overview = useQuery(projectOverviewOptions(projectId))

  if (overview.isError) {
    throw overview.error
  }

  if (!overview.data) {
    return <PageLoading />
  }

  const data = overview.data
  const changesAhead = data.counts.unreleasedChanges + data.counts.partiallyPresentChanges

  return (
    <ProjectShell
      overview={data}
      section="overview"
      actions={
        <Link
          to="/projects/$projectId/synchronization"
          params={{ projectId }}
          className={buttonVariants({ variant: 'outline' })}
        >
          Synchronization
          <ArrowRight data-icon="inline-end" />
        </Link>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard
          label="Unreleased changes"
          value={changesAhead}
          description={`${data.counts.partiallyPresentChanges} partially present`}
          icon={<GitPullRequest />}
        />
        <MetricCard
          label="Unmanaged commits"
          value={data.counts.unmanagedCommits}
          description="Direct commits in source range"
          icon={<GitCommit />}
        />
        <MetricCard
          label="Ambiguous commits"
          value={data.counts.ambiguousCommits}
          description="Conflicting PR evidence"
          icon={<AlertTriangle />}
        />
        <MetricCard
          label="Unknown changes"
          value={data.counts.unknownChanges}
          description="Identity retained as unknown"
          icon={<AlertTriangle />}
        />
        <Card>
          <CardHeader>
            <CardDescription>Required checks</CardDescription>
            <CardTitle className="mt-1">
              <CheckStateBadge state={data.requiredChecks.state} />
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Policy v{data.requiredChecks.policyVersion}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Repository range</CardTitle>
              <CardDescription>
                Branch heads from the latest atomically committed repository snapshot.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <BranchCard label="Source" branch={data.branches.source} />
              <BranchCard label="Production" branch={data.branches.production} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Required checks</CardTitle>
                  <CardDescription className="mt-1">
                    Effective policy from branch protection, repository rulesets and project
                    overrides.
                  </CardDescription>
                </div>
                <CheckStateBadge state={data.requiredChecks.state} />
              </div>
            </CardHeader>
            <CardContent>
              {data.requiredChecks.checks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No required checks are configured for the source branch.
                </p>
              ) : (
                <div className="grid gap-3">
                  {data.requiredChecks.checks.map((check) => (
                    <div
                      key={check.id}
                      className="flex flex-col justify-between gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{check.context}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatReason(check.source)}
                          {check.integrationId === null
                            ? ''
                            : ` · integration ${check.integrationId}`}
                        </p>
                      </div>
                      <CheckStateBadge state={check.state} />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Project health</CardTitle>
              <CardDescription>{data.health.summary}</CardDescription>
            </CardHeader>
            <CardContent>
              {data.health.reasons.length === 0 ? (
                <div className="flex gap-3 rounded-lg border bg-muted/20 p-3 text-sm">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                  <p>No inconsistencies or release warnings are currently recorded.</p>
                </div>
              ) : (
                <div className="grid gap-3">
                  {data.health.reasons.map((reason) => (
                    <div
                      key={`${reason.code}:${reason.message}`}
                      className="rounded-lg border bg-muted/20 p-3 text-sm"
                    >
                      <p className="font-medium">{formatReason(reason.code)}</p>
                      <p className="mt-1 text-muted-foreground">{reason.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>Latest synchronization</CardTitle>
                  <CardDescription className="mt-1">
                    Last authoritative comparison with GitHub.
                  </CardDescription>
                </div>
                {data.lastSynchronization ? (
                  <SynchronizationStatusBadge state={data.lastSynchronization.status} />
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              {data.lastSynchronization ? (
                <dl className="grid gap-3 text-sm">
                  <DetailRow label="Reason" value={formatReason(data.lastSynchronization.reason)} />
                  <DetailRow
                    label="Started"
                    value={formatDateTime(data.lastSynchronization.startedAt)}
                  />
                  <DetailRow
                    label="Duration"
                    value={formatDuration(data.lastSynchronization.durationMs)}
                  />
                  <DetailRow label="Issues" value={String(data.lastSynchronization.issueCount)} />
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No synchronization run has been recorded yet.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </ProjectShell>
  )
}

function MetricCard({
  label,
  value,
  description,
  icon,
}: {
  readonly label: string
  readonly value: number
  readonly description: string
  readonly icon: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <CardDescription>{label}</CardDescription>
          <span className="[&_svg]:size-4">{icon}</span>
        </div>
        <CardTitle className="mt-1 text-2xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{description}</CardContent>
    </Card>
  )
}

function BranchCard({
  label,
  branch,
}: {
  readonly label: string
  readonly branch: {
    readonly name: string
    readonly sha: string | null
    readonly protected: boolean | null
    readonly defaultBranch: boolean | null
    readonly observedAt: string | null
  }
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-4">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-2 font-medium">{branch.name}</p>
      <code className="mt-2 block break-all text-xs">{branch.sha ?? 'Not observed'}</code>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>
          {branch.protected === null
            ? 'Protection not observed'
            : branch.protected
              ? 'Protected'
              : 'Not protected'}
        </span>
        {branch.defaultBranch === true ? <span>· Default branch</span> : null}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Observed {formatDateTime(branch.observedAt)} · {shortSha(branch.sha)}
      </p>
    </div>
  )
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  )
}

function PageLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="h-96 animate-pulse rounded-xl bg-muted" />
    </main>
  )
}
