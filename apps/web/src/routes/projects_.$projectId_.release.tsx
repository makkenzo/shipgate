import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { AlertTriangle, CheckCircle2, GitPullRequest, Layers3, ShieldBan } from 'lucide-react'
import type { ReactNode } from 'react'

import {
  projectChangesOptions,
  projectOverviewOptions,
  projectReleaseCandidateOptions,
} from '@/api/project-queries'
import type { ProjectChange, ReleaseBlocker } from '@/api/projects'
import {
  CandidateStateBadge,
  ReleaseCandidateStatusBadge,
} from '@/components/project/project-badges'
import { ProjectShell } from '@/components/project/project-shell'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAuthenticatedRoute } from '@/lib/auth-route'
import { formatDateTime } from '@/lib/project-format'
import { describeReleaseBlocker, parseReleaseEvaluationSummary } from '@/lib/release-planning'

export const Route = createFileRoute('/projects_/$projectId_/release')({
  beforeLoad: ({ context }) => requireAuthenticatedRoute(context.queryClient),
  component: ProjectReleasePage,
})

function ProjectReleasePage() {
  const { projectId } = Route.useParams()
  const overview = useQuery(projectOverviewOptions(projectId))
  const changes = useQuery(projectChangesOptions(projectId))
  const candidate = useQuery(projectReleaseCandidateOptions(projectId))

  if (overview.isError) throw overview.error
  if (changes.isError) throw changes.error
  if (candidate.isError) throw candidate.error
  if (!overview.data || !changes.data || candidate.isPending) return <PageLoading />

  const activeCandidate = candidate.data
  const evaluation = parseReleaseEvaluationSummary(activeCandidate?.latestEvaluation?.summary)
  const changesById = new Map(changes.data.map((change) => [change.id, change] as const))
  const included = evaluation?.includedChanges ?? []
  const excluded = activeCandidate?.exclusions ?? []
  const blockers = evaluation?.blockers ?? []

  return (
    <ProjectShell overview={overview.data} section="release">
      {!activeCandidate ? (
        <Card>
          <CardHeader>
            <CardTitle>Next release</CardTitle>
            <CardDescription>
              A candidate appears after the first successful authoritative repository projection.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div>
                  <CardTitle>Next release</CardTitle>
                  <CardDescription>
                    Candidate #{activeCandidate.sequence}, evaluated from the current source and
                    production projection. Stage 5 never creates a branch.
                  </CardDescription>
                </div>
                <ReleaseCandidateStatusBadge status={activeCandidate.status} />
              </div>
            </CardHeader>
            <CardContent>
              {activeCandidate.status === 'evaluating' ? (
                <div className="mb-5 rounded-lg border bg-muted/20 p-3 text-sm">
                  Candidate reevaluation is {activeCandidate.pendingEvaluation?.status ?? 'pending'}
                  . The previous published result remains visible until the newer state wins.
                </div>
              ) : activeCandidate.status === 'ready' ? (
                <div className="mb-5 rounded-lg border bg-muted/20 p-3 text-sm">
                  <span className="inline-flex items-center gap-2 font-medium">
                    <CheckCircle2 className="size-4" /> Release ready
                  </span>
                  <p className="mt-1 text-muted-foreground">
                    All current planning gates pass. The next Stage adds the real Build release
                    operation.
                  </p>
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Metric
                  label="Status"
                  value={activeCandidate.status.toUpperCase()}
                  icon={<Layers3 />}
                />
                <Metric label="Included" value={included.length} icon={<GitPullRequest />} />
                <Metric label="Excluded" value={excluded.length} icon={<ShieldBan />} />
                <Metric label="Blockers" value={blockers.length} icon={<AlertTriangle />} />
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                Candidate v{activeCandidate.version}
                {activeCandidate.latestEvaluation
                  ? ` · evaluated ${formatDateTime(activeCandidate.latestEvaluation.evaluatedAt)}`
                  : ' · no published evaluation yet'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Included</CardTitle>
              <CardDescription>
                This is the actual deterministic order of the future release, with every
                prerequisite before its dependents.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {included.length === 0 ? (
                <p className="text-sm text-muted-foreground">No changes are currently included.</p>
              ) : (
                <ol className="grid gap-3">
                  {included.map((evaluatedChange, index) => {
                    const change = changesById.get(evaluatedChange.changeId)

                    return (
                      <li
                        key={evaluatedChange.changeId}
                        className="flex items-start gap-4 rounded-lg border p-4"
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">
                              #{evaluatedChange.pullRequestNumber}{' '}
                              {change?.title ??
                                'Change no longer present in the dashboard projection'}
                            </p>
                            <CandidateStateBadge state={evaluatedChange.status} />
                          </div>
                          {evaluatedChange.blockers.length > 0 ? (
                            <ul className="mt-2 grid gap-1 text-sm text-destructive">
                              {evaluatedChange.blockers.map((blocker) => (
                                <li key={blockerKey(blocker)}>
                                  {
                                    describeReleaseBlocker(blocker, {
                                      changesById,
                                      sourceBranch: overview.data.project.sourceBranch,
                                      productionBranch: overview.data.project.productionBranch,
                                    }).message
                                  }
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-sm text-muted-foreground">
                              All per-change gates pass.
                            </p>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Excluded</CardTitle>
              <CardDescription>
                Explicit candidate decisions retain the reason and the GitHub actor that made them.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {excluded.length === 0 ? (
                <p className="text-sm text-muted-foreground">No changes are excluded.</p>
              ) : (
                <div className="grid gap-3">
                  {excluded.map((exclusion) => {
                    const change = changesById.get(exclusion.changeId)
                    return (
                      <article key={exclusion.changeId} className="rounded-lg border p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-medium">
                            #{exclusion.pullRequestNumber ?? change?.pullRequestNumber ?? '—'}{' '}
                            {exclusion.title ?? change?.title ?? 'Unknown change'}
                          </p>
                          <Badge variant="outline">
                            GitHub user #{exclusion.actorGitHubUserId}
                          </Badge>
                        </div>
                        <p className="mt-2 text-sm">
                          {exclusion.reason ?? 'No exclusion reason was provided.'}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Excluded {formatDateTime(exclusion.excludedAt)} · candidate v
                          {exclusion.candidateVersion}
                        </p>
                      </article>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Blockers</CardTitle>
              <CardDescription>
                Concrete repository and pull-request gates, not an aggregate problem count.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ReleaseBlockerList
                blockers={blockers}
                changesById={changesById}
                sourceBranch={overview.data.project.sourceBranch}
                productionBranch={overview.data.project.productionBranch}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </ProjectShell>
  )
}

function Metric({
  label,
  value,
  icon,
}: {
  readonly label: string
  readonly value: string | number
  readonly icon: ReactNode
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>{label}</span>
        <span className="[&_svg]:size-4">{icon}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function ReleaseBlockerList({
  blockers,
  changesById,
  sourceBranch,
  productionBranch,
}: {
  readonly blockers: readonly ReleaseBlocker[]
  readonly changesById: ReadonlyMap<string, ProjectChange>
  readonly sourceBranch: string
  readonly productionBranch: string
}) {
  if (blockers.length === 0) {
    return <p className="text-sm text-muted-foreground">No blockers. Release ready.</p>
  }

  const unmanaged = blockers.filter(
    (blocker) => blocker.code === 'unmanaged_change' && blocker.changeId === null,
  )
  const ambiguous = blockers.filter(
    (blocker) => blocker.code === 'ambiguous_change' && blocker.changeId === null,
  )
  const remaining = blockers.filter(
    (blocker) =>
      !(blocker.code === 'unmanaged_change' && blocker.changeId === null) &&
      !(blocker.code === 'ambiguous_change' && blocker.changeId === null),
  )
  const entries = remaining.map((blocker) => ({
    key: blockerKey(blocker),
    ...describeReleaseBlocker(blocker, { changesById, sourceBranch, productionBranch }),
  }))

  if (unmanaged.length > 0) {
    entries.unshift({
      key: 'repository:unmanaged',
      subject: 'Repository',
      message: `${unmanaged.length} unmanaged commit${unmanaged.length === 1 ? '' : 's'} ${unmanaged.length === 1 ? 'exists' : 'exist'} between ${productionBranch} and ${sourceBranch}`,
    })
  }

  if (ambiguous.length > 0) {
    entries.unshift({
      key: 'repository:ambiguous',
      subject: 'Repository',
      message: `${ambiguous.length} commit${ambiguous.length === 1 ? '' : 's'} have ambiguous pull-request attribution`,
    })
  }

  return (
    <div className="grid gap-3">
      {entries.map((entry) => (
        <article key={entry.key} className="rounded-lg border p-4">
          <p className="font-medium">{entry.subject}</p>
          <p className="mt-1 text-sm text-destructive">{entry.message}</p>
        </article>
      ))}
    </div>
  )
}

function blockerKey(blocker: ReleaseBlocker): string {
  return [
    blocker.code,
    blocker.changeId,
    blocker.dependencyChangeId,
    blocker.checkName,
    blocker.commitSha,
  ].join(':')
}

function PageLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="h-96 animate-pulse rounded-xl bg-muted" />
    </main>
  )
}
