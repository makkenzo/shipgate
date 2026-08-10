import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ExternalLink, GitPullRequest } from 'lucide-react'

import { projectChangesOptions, projectOverviewOptions } from '@/api/project-queries'
import { CheckStateBadge, ProductionPresenceBadge } from '@/components/project/project-badges'
import { ProjectShell } from '@/components/project/project-shell'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAuthenticatedRoute } from '@/lib/auth-route'
import { formatDateTime, formatReason } from '@/lib/project-format'
import { toSafeHttpUrl } from '@/lib/safe-url'

export const Route = createFileRoute('/projects_/$projectId_/changes')({
  beforeLoad: ({ context }) => requireAuthenticatedRoute(context.queryClient),
  component: ProjectChangesPage,
})

function ProjectChangesPage() {
  const { projectId } = Route.useParams()
  const overview = useQuery(projectOverviewOptions(projectId))
  const changes = useQuery(projectChangesOptions(projectId))

  if (overview.isError) throw overview.error
  if (changes.isError) throw changes.error
  if (!overview.data || !changes.data) return <PageLoading />

  return (
    <ProjectShell overview={overview.data} section="changes">
      <Card>
        <CardHeader>
          <CardTitle>Changes between production and source</CardTitle>
          <CardDescription>
            Read-only pull-request attribution from the latest committed projection. QA,
            dependencies, exclusion and release membership are intentionally not editable yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0">
          {changes.data.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <GitPullRequest className="mx-auto size-7 text-muted-foreground" />
              <p className="mt-3 font-medium">No changes ahead of production</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Source and production currently have no projected pull-request changes between them.
              </p>
            </div>
          ) : (
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="border-y bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">PR</th>
                  <th className="px-4 py-3 font-medium">Title</th>
                  <th className="px-4 py-3 font-medium">Merge method</th>
                  <th className="px-4 py-3 font-medium">Merged at</th>
                  <th className="px-4 py-3 text-right font-medium">Commits</th>
                  <th className="px-4 py-3 font-medium">Production presence</th>
                  <th className="px-4 py-3 font-medium">Check state</th>
                  <th className="px-4 py-3 font-medium">Sync state</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {changes.data.map((change) => {
                  const url = toSafeHttpUrl(change.url)

                  return (
                    <tr key={change.id} className="align-top hover:bg-muted/20">
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
                      <td className="max-w-sm px-4 py-4">
                        <p className="font-medium">{change.title}</p>
                        {change.authorLogin ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            by {change.authorLogin}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4">{formatReason(change.mergeMethod)}</td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        {formatDateTime(change.mergedAt)}
                      </td>
                      <td className="px-4 py-4 text-right tabular-nums">{change.commitCount}</td>
                      <td className="px-4 py-4">
                        <ProductionPresenceBadge state={change.productionPresence} />
                      </td>
                      <td className="px-4 py-4">
                        <CheckStateBadge state={change.checkState} />
                      </td>
                      <td className="px-4 py-4">
                        <Badge
                          variant={
                            change.synchronizationState === 'known' ? 'outline' : 'destructive'
                          }
                        >
                          {change.synchronizationState === 'known' ? 'Known' : 'Unknown'}
                        </Badge>
                      </td>
                    </tr>
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

function PageLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="h-96 animate-pulse rounded-xl bg-muted" />
    </main>
  )
}
