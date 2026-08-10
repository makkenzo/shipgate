import { Link } from '@tanstack/react-router'
import { ExternalLink, GitBranch } from 'lucide-react'
import type { ReactNode } from 'react'

import type { ProjectOverview } from '@/api/projects'
import { ProjectHealthBadge } from '@/components/project/project-badges'
import { buttonVariants } from '@/components/ui/button'
import { shortSha } from '@/lib/project-format'
import { toSafeHttpUrl } from '@/lib/safe-url'
import { cn } from '@/lib/utils'

type ProjectSection = 'overview' | 'changes' | 'synchronization' | 'settings'

export function ProjectShell({
  overview,
  section,
  actions,
  children,
}: {
  readonly overview: ProjectOverview
  readonly section: ProjectSection
  readonly actions?: ReactNode
  readonly children: ReactNode
}) {
  const { project } = overview
  const repositoryUrl = toSafeHttpUrl(`https://github.com/${project.repository.fullName}`)

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-muted-foreground">Project</p>
            <ProjectHealthBadge state={overview.health.state} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="truncate text-3xl font-semibold tracking-tight">
              {project.repository.fullName}
            </h1>
            {repositoryUrl ? (
              <a
                href={repositoryUrl}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
                aria-label="Open repository on GitHub"
              >
                <ExternalLink />
              </a>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <GitBranch className="size-4" />
              {project.sourceBranch} <code>{shortSha(overview.branches.source.sha)}</code>
            </span>
            <span>
              Production: {project.productionBranch}{' '}
              <code>{shortSha(overview.branches.production.sha)}</code>
            </span>
          </div>
        </div>

        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>

      <nav className="mt-8 flex gap-1 overflow-x-auto border-b" aria-label="Project sections">
        <ProjectTab projectId={project.id} section={section} target="overview" label="Overview" />
        <ProjectTab projectId={project.id} section={section} target="changes" label="Changes" />
        <ProjectTab
          projectId={project.id}
          section={section}
          target="synchronization"
          label="Synchronization"
        />
        <ProjectTab projectId={project.id} section={section} target="settings" label="Settings" />
      </nav>

      <div className="pt-8">{children}</div>
    </main>
  )
}

function ProjectTab({
  projectId,
  section,
  target,
  label,
}: {
  readonly projectId: string
  readonly section: ProjectSection
  readonly target: ProjectSection
  readonly label: string
}) {
  const className = cn(
    '-mb-px whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition-colors',
    section === target
      ? 'border-foreground text-foreground'
      : 'border-transparent text-muted-foreground hover:text-foreground',
  )

  switch (target) {
    case 'overview':
      return (
        <Link to="/projects/$projectId" params={{ projectId }} className={className}>
          {label}
        </Link>
      )
    case 'changes':
      return (
        <Link to="/projects/$projectId/changes" params={{ projectId }} className={className}>
          {label}
        </Link>
      )
    case 'synchronization':
      return (
        <Link
          to="/projects/$projectId/synchronization"
          params={{ projectId }}
          className={className}
        >
          {label}
        </Link>
      )
    case 'settings':
      return (
        <Link to="/projects/$projectId/settings" params={{ projectId }} className={className}>
          {label}
        </Link>
      )
  }
}
