import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Network,
  RotateCcw,
  Undo2,
  XCircle,
} from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'

import {
  projectChangeDependenciesOptions,
  projectChangesOptions,
  projectKeys,
  projectOverviewOptions,
  projectReleaseCandidateOptions,
} from '@/api/project-queries'
import {
  excludeProjectChangeFromCandidate,
  type ProjectChange,
  type ProjectChangeDependency,
  type ReleaseBlocker,
  restoreProjectChangeToCandidate,
  setProjectChangeDependencies,
  setProjectChangeQa,
} from '@/api/projects'
import {
  CandidateStateBadge,
  CheckStateBadge,
  ProductionPresenceBadge,
  QaStatusBadge,
} from '@/components/project/project-badges'
import { ProjectShell } from '@/components/project/project-shell'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAuthenticatedRoute } from '@/lib/auth-route'
import { describeReleaseBlocker, parseReleaseEvaluationSummary } from '@/lib/release-planning'
import { toSafeHttpUrl } from '@/lib/safe-url'

export const Route = createFileRoute('/projects_/$projectId_/changes')({
  beforeLoad: ({ context }) => requireAuthenticatedRoute(context.queryClient),
  component: ProjectChangesPage,
})

type EditorState =
  | {
      readonly kind: 'dependencies'
      readonly changeId: string
      readonly selectedChangeIds: readonly string[]
    }
  | {
      readonly kind: 'exclude'
      readonly changeId: string
      readonly reason: string
    }

type PlanningCommand =
  | {
      readonly type: 'qa'
      readonly changeId: string
      readonly status: 'pending' | 'passed' | 'failed'
    }
  | {
      readonly type: 'dependencies'
      readonly changeId: string
      readonly dependencyChangeIds: readonly string[]
    }
  | {
      readonly type: 'exclude'
      readonly changeId: string
      readonly reason: string
    }
  | {
      readonly type: 'restore'
      readonly changeId: string
    }

function ProjectChangesPage() {
  const { projectId } = Route.useParams()
  const queryClient = useQueryClient()
  const overview = useQuery(projectOverviewOptions(projectId))
  const changes = useQuery(projectChangesOptions(projectId))
  const candidate = useQuery(projectReleaseCandidateOptions(projectId))
  const dependencyQueries = useQueries({
    queries: (changes.data ?? []).map((change) =>
      projectChangeDependenciesOptions(projectId, change.id),
    ),
  })
  const [editor, setEditor] = useState<EditorState | null>(null)
  const mutation = useMutation({
    mutationFn: async (command: PlanningCommand) => {
      switch (command.type) {
        case 'qa':
          return setProjectChangeQa(projectId, command.changeId, { status: command.status })
        case 'dependencies':
          return setProjectChangeDependencies(
            projectId,
            command.changeId,
            command.dependencyChangeIds,
          )
        case 'exclude':
          return excludeProjectChangeFromCandidate(
            projectId,
            command.changeId,
            command.reason.trim() || undefined,
          )
        case 'restore':
          return restoreProjectChangeToCandidate(projectId, command.changeId)
      }
    },
    onSuccess: async (_result, command) => {
      setEditor((current) => (current?.changeId === command.changeId ? null : current))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectKeys.changes(projectId) }),
        queryClient.invalidateQueries({ queryKey: projectKeys.releaseCandidate(projectId) }),
        queryClient.invalidateQueries({
          queryKey: projectKeys.dependencies(projectId, command.changeId),
        }),
        queryClient.invalidateQueries({ queryKey: projectKeys.overview(projectId) }),
      ])
    },
  })

  if (overview.isError) throw overview.error
  if (changes.isError) throw changes.error
  if (candidate.isError) throw candidate.error
  if (!overview.data || !changes.data || candidate.isPending) return <PageLoading />

  const evaluation = parseReleaseEvaluationSummary(candidate.data?.latestEvaluation?.summary)
  const evaluatedByChangeId = new Map(
    [...(evaluation?.includedChanges ?? []), ...(evaluation?.excludedChanges ?? [])].map(
      (change) => [change.changeId, change] as const,
    ),
  )
  const exclusionByChangeId = new Map(
    (candidate.data?.exclusions ?? []).map((exclusion) => [exclusion.changeId, exclusion] as const),
  )
  const changesById = new Map(changes.data.map((change) => [change.id, change] as const))
  const dependenciesByChangeId = new Map<
    string,
    {
      readonly data: readonly ProjectChangeDependency[] | undefined
      readonly isPending: boolean
      readonly isError: boolean
    }
  >()

  changes.data.forEach((change, index) => {
    const query = dependencyQueries[index]
    dependenciesByChangeId.set(change.id, {
      data: query?.data,
      isPending: query?.isPending ?? true,
      isError: query?.isError ?? false,
    })
  })

  return (
    <ProjectShell
      overview={overview.data}
      section="changes"
      actions={
        <Link
          to="/projects/$projectId/release"
          params={{ projectId }}
          className={buttonVariants({ variant: 'outline' })}
        >
          Next release
          <ArrowRight data-icon="inline-end" />
        </Link>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle>Release planning changes</CardTitle>
          <CardDescription>
            QA, required checks, dependencies and explicit exclusions feed the active release
            candidate. Every mutation queues a fresh deterministic evaluation.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0">
          {mutation.isError ? (
            <div
              role="alert"
              className="mx-4 mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
            >
              {mutation.error instanceof Error
                ? mutation.error.message
                : 'The release-planning operation failed.'}
            </div>
          ) : null}

          {changes.data.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <GitPullRequest className="mx-auto size-7 text-muted-foreground" />
              <p className="mt-3 font-medium">No changes ahead of production</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Source and production currently have no projected pull-request changes between them.
              </p>
            </div>
          ) : (
            <table className="w-full min-w-[1480px] text-left text-sm">
              <thead className="border-y bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">PR</th>
                  <th className="px-4 py-3 font-medium">Title</th>
                  <th className="px-4 py-3 font-medium">QA</th>
                  <th className="px-4 py-3 font-medium">Checks</th>
                  <th className="px-4 py-3 font-medium">Dependencies</th>
                  <th className="px-4 py-3 font-medium">Production presence</th>
                  <th className="px-4 py-3 font-medium">Candidate state</th>
                  <th className="px-4 py-3 font-medium">Blockers</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {changes.data.map((change) => {
                  const url = toSafeHttpUrl(change.url)
                  const dependencies = dependenciesByChangeId.get(change.id)
                  const evaluated = evaluatedByChangeId.get(change.id)
                  const exclusion = exclusionByChangeId.get(change.id)
                  const candidateState = exclusion
                    ? 'excluded'
                    : candidate.data?.status === 'evaluating'
                      ? 'evaluating'
                      : (evaluated?.status ?? 'unknown')
                  const pending = mutation.isPending && mutation.variables?.changeId === change.id

                  return (
                    <Fragment key={change.id}>
                      <tr className="align-top hover:bg-muted/20">
                        <td className="px-4 py-4 font-medium">
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              #{change.pullRequestNumber}
                              <ExternalLink className="size-3" />
                            </a>
                          ) : (
                            `#${change.pullRequestNumber}`
                          )}
                        </td>
                        <td className="max-w-xs px-4 py-4">
                          <p className="font-medium">{change.title}</p>
                          {change.authorLogin ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              by {change.authorLogin}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-4">
                          <QaStatusBadge status={change.qa.status} />
                          {change.qa.comment ? (
                            <p className="mt-2 max-w-48 text-xs text-muted-foreground">
                              {change.qa.comment}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-4">
                          <CheckStateBadge state={change.checkState} />
                        </td>
                        <td className="max-w-52 px-4 py-4">
                          <DependencySummary state={dependencies} />
                        </td>
                        <td className="px-4 py-4">
                          <ProductionPresenceBadge state={change.productionPresence} />
                        </td>
                        <td className="px-4 py-4">
                          <CandidateStateBadge state={candidateState} />
                        </td>
                        <td className="max-w-sm px-4 py-4">
                          <ChangeBlockers
                            blockers={evaluated?.blockers ?? []}
                            evaluating={candidate.data?.status === 'evaluating' && !exclusion}
                            changesById={changesById}
                            sourceBranch={overview.data.project.sourceBranch}
                            productionBranch={overview.data.project.productionBranch}
                          />
                        </td>
                        <td className="w-[340px] px-4 py-4">
                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              disabled={pending || change.qa.status === 'passed'}
                              onClick={() => {
                                mutation.reset()
                                mutation.mutate({
                                  type: 'qa',
                                  changeId: change.id,
                                  status: 'passed',
                                })
                              }}
                            >
                              <CheckCircle2 data-icon="inline-start" />
                              QA Passed
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="destructive"
                              disabled={pending || change.qa.status === 'failed'}
                              onClick={() => {
                                mutation.reset()
                                mutation.mutate({
                                  type: 'qa',
                                  changeId: change.id,
                                  status: 'failed',
                                })
                              }}
                            >
                              <XCircle data-icon="inline-start" />
                              QA Failed
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              disabled={pending || change.qa.status === 'pending'}
                              onClick={() => {
                                mutation.reset()
                                mutation.mutate({
                                  type: 'qa',
                                  changeId: change.id,
                                  status: 'pending',
                                })
                              }}
                            >
                              <RotateCcw data-icon="inline-start" />
                              Reset QA
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              disabled={pending || dependencies?.isPending || dependencies?.isError}
                              aria-expanded={
                                editor?.kind === 'dependencies' && editor.changeId === change.id
                              }
                              onClick={() => {
                                mutation.reset()
                                setEditor({
                                  kind: 'dependencies',
                                  changeId: change.id,
                                  selectedChangeIds:
                                    dependencies?.data?.map((dependency) => dependency.changeId) ??
                                    [],
                                })
                              }}
                            >
                              <Network data-icon="inline-start" />
                              Edit dependencies
                            </Button>
                            {exclusion ? (
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                disabled={pending}
                                onClick={() => {
                                  mutation.reset()
                                  mutation.mutate({ type: 'restore', changeId: change.id })
                                }}
                              >
                                <Undo2 data-icon="inline-start" />
                                Restore
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                size="xs"
                                variant="destructive"
                                disabled={pending}
                                aria-expanded={
                                  editor?.kind === 'exclude' && editor.changeId === change.id
                                }
                                onClick={() => {
                                  mutation.reset()
                                  setEditor({ kind: 'exclude', changeId: change.id, reason: '' })
                                }}
                              >
                                <Ban data-icon="inline-start" />
                                Exclude
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {editor?.changeId === change.id ? (
                        <tr className="bg-muted/15">
                          <td colSpan={9} className="px-4 py-4">
                            {editor.kind === 'dependencies' ? (
                              <DependencyEditor
                                change={change}
                                changes={changes.data}
                                existingDependencies={dependencies?.data ?? []}
                                selectedChangeIds={editor.selectedChangeIds}
                                pending={pending}
                                onSelectedChange={(selectedChangeIds) =>
                                  setEditor({
                                    kind: 'dependencies',
                                    changeId: change.id,
                                    selectedChangeIds,
                                  })
                                }
                                onCancel={() => setEditor(null)}
                                onSave={() =>
                                  mutation.mutate({
                                    type: 'dependencies',
                                    changeId: change.id,
                                    dependencyChangeIds: editor.selectedChangeIds,
                                  })
                                }
                              />
                            ) : (
                              <ExclusionEditor
                                change={change}
                                reason={editor.reason}
                                pending={pending}
                                onReasonChange={(reason) =>
                                  setEditor({ kind: 'exclude', changeId: change.id, reason })
                                }
                                onCancel={() => setEditor(null)}
                                onExclude={() =>
                                  mutation.mutate({
                                    type: 'exclude',
                                    changeId: change.id,
                                    reason: editor.reason,
                                  })
                                }
                              />
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </ProjectShell>
  )
}

function DependencySummary({
  state,
}: {
  readonly state:
    | {
        readonly data: readonly ProjectChangeDependency[] | undefined
        readonly isPending: boolean
        readonly isError: boolean
      }
    | undefined
}) {
  if (!state || state.isPending) return <span className="text-muted-foreground">Loading…</span>
  if (state.isError) return <span className="text-destructive">Unavailable</span>
  if (!state.data || state.data.length === 0) {
    return <span className="text-muted-foreground">None</span>
  }

  return (
    <div className="flex flex-wrap gap-1">
      {state.data.map((dependency) => (
        <Badge key={dependency.changeId} variant="outline">
          #{dependency.pullRequestNumber}
        </Badge>
      ))}
    </div>
  )
}

function ChangeBlockers({
  blockers,
  evaluating,
  changesById,
  sourceBranch,
  productionBranch,
}: {
  readonly blockers: readonly ReleaseBlocker[]
  readonly evaluating: boolean
  readonly changesById: ReadonlyMap<string, ProjectChange>
  readonly sourceBranch: string
  readonly productionBranch: string
}) {
  if (evaluating) return <span className="text-muted-foreground">Evaluation in progress…</span>
  if (blockers.length === 0) return <span className="text-muted-foreground">None</span>

  return (
    <ul className="grid gap-1.5">
      {blockers.map((blocker) => {
        const description = describeReleaseBlocker(blocker, {
          changesById,
          sourceBranch,
          productionBranch,
        })
        const key = [
          blocker.code,
          blocker.changeId,
          blocker.dependencyChangeId,
          blocker.checkName,
          blocker.commitSha,
        ].join(':')

        return (
          <li key={key} className="text-xs text-destructive">
            {description.message}
          </li>
        )
      })}
    </ul>
  )
}

function DependencyEditor({
  change,
  changes,
  existingDependencies,
  selectedChangeIds,
  pending,
  onSelectedChange,
  onCancel,
  onSave,
}: {
  readonly change: ProjectChange
  readonly changes: readonly ProjectChange[]
  readonly existingDependencies: readonly ProjectChangeDependency[]
  readonly selectedChangeIds: readonly string[]
  readonly pending: boolean
  readonly onSelectedChange: (changeIds: readonly string[]) => void
  readonly onCancel: () => void
  readonly onSave: () => void
}) {
  const options = useMemo(() => {
    const current = changes
      .filter((candidate) => candidate.id !== change.id)
      .map((candidate) => ({
        changeId: candidate.id,
        pullRequestNumber: candidate.pullRequestNumber,
        title: candidate.title,
        outsideQueue: false,
      }))
    const currentIds = new Set(current.map((candidate) => candidate.changeId))

    for (const dependency of existingDependencies) {
      if (!currentIds.has(dependency.changeId)) {
        current.push({
          changeId: dependency.changeId,
          pullRequestNumber: dependency.pullRequestNumber,
          title: 'Outside the current release queue',
          outsideQueue: true,
        })
      }
    }

    return current.toSorted(
      (left, right) =>
        left.pullRequestNumber - right.pullRequestNumber ||
        left.changeId.localeCompare(right.changeId),
    )
  }, [change.id, changes, existingDependencies])
  const selected = new Set(selectedChangeIds)

  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <p className="font-medium">Dependencies for PR #{change.pullRequestNumber}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Shipgate mirrors the selection into the managed block in the pull-request body.
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={pending} onClick={onSave}>
            {pending ? 'Saving…' : 'Save dependencies'}
          </Button>
        </div>
      </div>

      {options.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No other projected changes are available.
        </p>
      ) : (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {options.map((option) => {
            const inputId = `dependency-${change.id}-${option.changeId}`
            return (
              <label
                key={option.changeId}
                htmlFor={inputId}
                className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm hover:bg-muted/30"
              >
                <input
                  id={inputId}
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={selected.has(option.changeId)}
                  disabled={pending}
                  onChange={(event) => {
                    const next = new Set(selected)
                    if (event.currentTarget.checked) next.add(option.changeId)
                    else next.delete(option.changeId)
                    onSelectedChange([...next].toSorted())
                  }}
                />
                <span>
                  <span className="font-medium">#{option.pullRequestNumber}</span> {option.title}
                  {option.outsideQueue ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Already released or no longer in the current queue
                    </span>
                  ) : null}
                </span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ExclusionEditor({
  change,
  reason,
  pending,
  onReasonChange,
  onCancel,
  onExclude,
}: {
  readonly change: ProjectChange
  readonly reason: string
  readonly pending: boolean
  readonly onReasonChange: (reason: string) => void
  readonly onCancel: () => void
  readonly onExclude: () => void
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
        <label className="min-w-0 flex-1 text-sm">
          <span className="font-medium">Exclude PR #{change.pullRequestNumber}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            The reason and your GitHub actor ID remain attached to the active candidate.
          </span>
          <textarea
            aria-label={`Exclusion reason for PR #${change.pullRequestNumber}`}
            value={reason}
            maxLength={4_000}
            rows={2}
            disabled={pending}
            placeholder="Reason (optional)"
            className="mt-3 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
            onChange={(event) => onReasonChange(event.currentTarget.value)}
          />
        </label>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={onExclude}>
            {pending ? 'Excluding…' : 'Confirm exclusion'}
          </Button>
        </div>
      </div>
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
