import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowRight, GitBranch, Plus } from 'lucide-react'

import { projectsOptions } from '@/api/project-queries'
import { ProjectStatusBadge } from '@/components/project/project-badges'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAuthenticatedRoute } from '@/lib/auth-route'
import { formatDateTime, shortSha } from '@/lib/project-format'

export const Route = createFileRoute('/projects')({
  beforeLoad: ({ context }) => requireAuthenticatedRoute(context.queryClient),
  component: ProjectsPage,
})

function ProjectsPage() {
  const projects = useQuery(projectsOptions())

  if (projects.isError) {
    throw projects.error
  }

  const projectList = projects.data ?? []

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Release visibility</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Read-only repository projections for every change between production and source.
          </p>
        </div>

        <Link to="/projects/new" className={buttonVariants()}>
          <Plus data-icon="inline-start" />
          New project
        </Link>
      </div>

      {projects.isPending ? (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {[0, 1].map((item) => (
            <div key={item} className="h-52 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : projectList.length === 0 ? (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>No projects yet</CardTitle>
            <CardDescription>
              Connect a repository and choose distinct source and production branches.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link to="/projects/new" className={buttonVariants()}>
              <GitBranch data-icon="inline-start" />
              Create project
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {projectList.map((project) => (
            <Card key={project.id} className="transition-shadow hover:shadow-sm">
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{project.repository.fullName}</CardTitle>
                    <CardDescription className="mt-1">
                      Configuration v{project.configurationVersion}
                    </CardDescription>
                  </div>
                  <ProjectStatusBadge status={project.status} />
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 text-sm">
                  <BranchRow label="Source" branch={project.sourceBranch} sha={project.sourceSha} />
                  <BranchRow
                    label="Production"
                    branch={project.productionBranch}
                    sha={project.productionSha}
                  />
                </div>

                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-muted-foreground">
                    Last synchronized {formatDateTime(project.lastSuccessfulSynchronization)}
                  </span>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: project.id }}
                    className="inline-flex items-center gap-1 font-medium hover:underline"
                  >
                    Open
                    <ArrowRight className="size-4" />
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </main>
  )
}

function BranchRow({
  label,
  branch,
  sha,
}: {
  readonly label: string
  readonly branch: string
  readonly sha: string | null
}) {
  return (
    <div className="grid grid-cols-[5rem_1fr_auto] items-center gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium">{branch}</span>
      <code className="text-xs text-muted-foreground">{shortSha(sha)}</code>
    </div>
  )
}
