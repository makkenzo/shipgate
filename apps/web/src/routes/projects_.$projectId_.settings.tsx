import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Save, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { projectKeys, projectOverviewOptions } from '@/api/project-queries'
import { deleteProject, updateProject } from '@/api/projects'
import { ProjectShell } from '@/components/project/project-shell'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAuthenticatedRoute } from '@/lib/auth-route'

export const Route = createFileRoute('/projects_/$projectId_/settings')({
  beforeLoad: ({ context }) => requireAuthenticatedRoute(context.queryClient),
  component: ProjectSettingsPage,
})

function ProjectSettingsPage() {
  const { projectId } = Route.useParams()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const overview = useQuery(projectOverviewOptions(projectId))
  const [sourceBranch, setSourceBranch] = useState('')
  const [productionBranch, setProductionBranch] = useState('')
  const [requiredChecks, setRequiredChecks] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const loadedConfigurationVersion = useRef<number | null>(null)

  useEffect(() => {
    const project = overview.data?.project

    if (!project || loadedConfigurationVersion.current === project.configurationVersion) {
      return
    }

    loadedConfigurationVersion.current = project.configurationVersion
    setSourceBranch(project.sourceBranch)
    setProductionBranch(project.productionBranch)
    setRequiredChecks(formatOverrides(project.requiredCheckOverrides))
  }, [overview.data])

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!overview.data) throw new Error('Project is not loaded')

      const overrides = parseOverrides(requiredChecks)
      setParseError(null)

      return updateProject(projectId, {
        expectedConfigurationVersion: overview.data.project.configurationVersion,
        sourceBranch: sourceBranch.trim(),
        productionBranch: productionBranch.trim(),
        requiredCheckOverrides: overrides,
      })
    },
    onSuccess: async () => invalidateProject(queryClient, projectId),
    onError: (error) => {
      if (error instanceof RequiredCheckOverrideParseError) {
        setParseError(error.message)
      }
    },
  })
  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!overview.data) throw new Error('Project is not loaded')

      return deleteProject(projectId, overview.data.project.configurationVersion)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: projectKeys.all })
      await navigate({ to: '/projects' })
    },
  })

  if (overview.isError) throw overview.error
  if (!overview.data) return <PageLoading />

  const project = overview.data.project
  const invalid =
    sourceBranch.trim().length === 0 ||
    productionBranch.trim().length === 0 ||
    sourceBranch.trim() === productionBranch.trim() ||
    project.status === 'disconnected' ||
    project.status === 'pending_deletion' ||
    project.status === 'deleted'

  return (
    <ProjectShell overview={overview.data} section="settings">
      <div className="grid gap-6 lg:grid-cols-[1fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardTitle>Branch configuration</CardTitle>
            <CardDescription>
              Changing either branch invalidates the current topology and queues a full
              reconciliation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-5"
              onSubmit={(event) => {
                event.preventDefault()
                if (!invalid) updateMutation.mutate()
              }}
            >
              <Field controlId="project-settings-source-branch" label="Source branch">
                <input
                  id="project-settings-source-branch"
                  className={inputClassName}
                  value={sourceBranch}
                  onChange={(event) => setSourceBranch(event.target.value)}
                />
              </Field>
              <Field controlId="project-settings-production-branch" label="Production branch">
                <input
                  id="project-settings-production-branch"
                  className={inputClassName}
                  value={productionBranch}
                  onChange={(event) => setProductionBranch(event.target.value)}
                />
              </Field>

              {sourceBranch.trim() === productionBranch.trim() ? (
                <p className="text-sm text-destructive">
                  Source and production must be different branches.
                </p>
              ) : null}

              <Field
                controlId="project-settings-required-check-overrides"
                label="Required-check overrides"
              >
                <textarea
                  id="project-settings-required-check-overrides"
                  className={`${inputClassName} min-h-36 resize-y py-2 font-mono`}
                  value={requiredChecks}
                  onChange={(event) => {
                    setRequiredChecks(event.target.value)
                    setParseError(null)
                  }}
                  placeholder={'shipgate/manual\nci/build # 12345'}
                />
                <span className="font-normal text-muted-foreground">
                  One context per line. Add <code># integration-id</code> to require a specific
                  GitHub App.
                </span>
              </Field>

              {parseError ? <p className="text-sm text-destructive">{parseError}</p> : null}

              {updateMutation.isError && !parseError ? (
                <p className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
                  {updateMutation.error instanceof Error
                    ? updateMutation.error.message
                    : 'Unable to update project'}
                </p>
              ) : null}

              {updateMutation.isSuccess ? (
                <p className="rounded-lg border bg-muted/30 p-3 text-sm">
                  Configuration saved. Shipgate queued any required authoritative reconciliation.
                </p>
              ) : null}

              <div className="flex justify-end border-t pt-5">
                <Button type="submit" disabled={invalid || updateMutation.isPending}>
                  <Save data-icon="inline-start" />
                  {updateMutation.isPending ? 'Saving…' : 'Save configuration'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Configuration semantics</CardTitle>
              <CardDescription>Shipgate never guesses branch or change identity.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <p>
                Production must be an ancestor of source. Missing or diverged branches are rejected
                before configuration is committed.
              </p>
              <p>
                A branch change increments configuration version, preserves the previous projection
                for diagnosis and rebuilds from GitHub.
              </p>
              <p>
                Required-check overrides are additive to branch protection and active repository
                rulesets.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Remove project</CardTitle>
              <CardDescription>
                Stops synchronization and removes the local project projection. This does not change
                the GitHub repository.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {deleteMutation.isError ? (
                <p className="text-sm text-destructive">
                  {deleteMutation.error instanceof Error
                    ? deleteMutation.error.message
                    : 'Unable to remove project'}
                </p>
              ) : null}
              <Button
                type="button"
                variant="destructive"
                disabled={deleteMutation.isPending || project.status === 'deleted'}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${project.repository.fullName} from Shipgate? GitHub will not be changed.`,
                    )
                  ) {
                    deleteMutation.mutate()
                  }
                }}
              >
                <Trash2 data-icon="inline-start" />
                {deleteMutation.isPending ? 'Removing…' : 'Remove project'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </ProjectShell>
  )
}

function Field({
  controlId,
  label,
  children,
}: {
  readonly controlId: string
  readonly label: string
  readonly children: ReactNode
}) {
  return (
    <div className="grid gap-2 text-sm font-medium">
      <label htmlFor={controlId}>{label}</label>
      {children}
    </div>
  )
}

function formatOverrides(
  overrides: readonly { readonly context: string; readonly integrationId: number | null }[],
): string {
  return overrides
    .map((override) =>
      override.integrationId === null
        ? override.context
        : `${override.context} # ${override.integrationId}`,
    )
    .join('\n')
}

function parseOverrides(
  value: string,
): Array<{ readonly context: string; readonly integrationId: number | null }> {
  const overrides = value
    .split('\n')
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter((item) => item.line.length > 0)
    .map(({ line, lineNumber }) => {
      const match = /^(.*?)(?:\s+#\s+([1-9][0-9]*))?$/.exec(line)
      const context = match?.[1]?.trim() ?? ''
      const integrationId = match?.[2] ? Number(match[2]) : null

      if (integrationId !== null && !Number.isSafeInteger(integrationId)) {
        throw new RequiredCheckOverrideParseError(
          `Required-check integration ID on line ${lineNumber} is outside JavaScript's safe integer range.`,
        )
      }

      if (!context) {
        throw new RequiredCheckOverrideParseError(
          `Required-check context on line ${lineNumber} must not be empty.`,
        )
      }

      if (context.length > 255) {
        throw new RequiredCheckOverrideParseError(
          `Required-check context on line ${lineNumber} is longer than 255 characters.`,
        )
      }

      return { context, integrationId }
    })
  const identities = new Set<string>()

  for (const override of overrides) {
    const identity = `${override.context}\0${override.integrationId ?? ''}`

    if (identities.has(identity)) {
      throw new RequiredCheckOverrideParseError(
        `Required-check override ${override.context} is duplicated.`,
      )
    }

    identities.add(identity)
  }

  return overrides
}

class RequiredCheckOverrideParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequiredCheckOverrideParseError'
  }
}

async function invalidateProject(queryClient: QueryClient, projectId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: projectKeys.overview(projectId) }),
    queryClient.invalidateQueries({ queryKey: projectKeys.changes(projectId) }),
    queryClient.invalidateQueries({ queryKey: projectKeys.synchronization(projectId) }),
    queryClient.invalidateQueries({ queryKey: projectKeys.list() }),
  ])
}

const inputClassName =
  'h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-shadow focus:border-ring focus:ring-3 focus:ring-ring/20'

function PageLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="h-96 animate-pulse rounded-xl bg-muted" />
    </main>
  )
}
