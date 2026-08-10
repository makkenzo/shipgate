import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, GitBranch } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import { installationOptions, installationsOptions } from '@/api/connection-queries'
import { projectKeys } from '@/api/project-queries'
import { createProject } from '@/api/projects'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAuthenticatedRoute } from '@/lib/auth-route'

export const Route = createFileRoute('/projects_/new')({
  beforeLoad: ({ context }) => requireAuthenticatedRoute(context.queryClient),
  component: NewProjectPage,
})

function NewProjectPage() {
  const installations = useQuery(installationsOptions())
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [installationId, setInstallationId] = useState('')
  const [repositoryId, setRepositoryId] = useState('')
  const [sourceBranch, setSourceBranch] = useState('develop')
  const [productionBranch, setProductionBranch] = useState('main')
  const numericInstallationId = Number(installationId)
  const installationIdIsValid =
    Number.isSafeInteger(numericInstallationId) && numericInstallationId > 0
  const installation = useQuery(installationOptions(numericInstallationId, installationIdIsValid))
  const repositories = useMemo(
    () =>
      installation.data?.repositories.filter(
        (repository) =>
          repository.accessibleToUser &&
          !repository.archived &&
          !repository.disabled &&
          ['maintain', 'admin'].includes(repository.userPermission),
      ) ?? [],
    [installation.data],
  )
  const selectedRepository = repositories.find(
    (repository) => String(repository.id) === repositoryId,
  )
  const mutation = useMutation({
    mutationFn: createProject,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: projectKeys.all })
      await navigate({
        to: '/projects/$projectId',
        params: { projectId: result.project.id },
      })
    },
  })

  if (installations.isError) {
    throw installations.error
  }

  if (installation.isError) {
    throw installation.error
  }

  const canSubmit =
    selectedRepository !== undefined &&
    sourceBranch.trim().length > 0 &&
    productionBranch.trim().length > 0 &&
    sourceBranch.trim() !== productionBranch.trim() &&
    !mutation.isPending

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link to="/projects" className={buttonVariants({ variant: 'ghost' })}>
        <ArrowLeft data-icon="inline-start" />
        Projects
      </Link>

      <div className="mt-6">
        <p className="text-sm font-medium text-muted-foreground">Repository configuration</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">New project</h1>
        <p className="mt-2 text-muted-foreground">
          Select a GitHub repository and define the branch range Shipgate must model.
        </p>
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            Maintain or Admin repository permission and the configured GitHub App permissions are
            required.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault()
              if (!canSubmit) return

              mutation.mutate({
                installationId: numericInstallationId,
                repositoryId: selectedRepository.id,
                sourceBranch: sourceBranch.trim(),
                productionBranch: productionBranch.trim(),
              })
            }}
          >
            <Field controlId="new-project-installation" label="GitHub installation">
              <select
                id="new-project-installation"
                className={inputClassName}
                value={installationId}
                onChange={(event) => {
                  setInstallationId(event.target.value)
                  setRepositoryId('')
                }}
                required
              >
                <option value="">Select an installation</option>
                {installations.data
                  ?.filter(
                    (candidate) =>
                      candidate.lifecycleState === 'active' &&
                      candidate.permissionState === 'current' &&
                      !candidate.permissionUpgradePending,
                  )
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.owner.login}
                    </option>
                  ))}
              </select>
            </Field>

            <Field controlId="new-project-repository" label="Repository">
              <select
                id="new-project-repository"
                className={inputClassName}
                value={repositoryId}
                onChange={(event) => {
                  const value = event.target.value
                  setRepositoryId(value)
                  const repository = repositories.find(
                    (candidate) => String(candidate.id) === value,
                  )

                  if (repository?.defaultBranch) {
                    setProductionBranch(repository.defaultBranch)
                  }
                }}
                disabled={!installationIdIsValid || installation.isPending}
                required
              >
                <option value="">
                  {installation.isPending ? 'Loading repositories…' : 'Select a repository'}
                </option>
                {repositories.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {repository.fullName}
                  </option>
                ))}
              </select>
              {installation.data && repositories.length === 0 ? (
                <span className="font-normal text-muted-foreground">
                  No active repository with Maintain or Admin access is available in this
                  installation.
                </span>
              ) : null}
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                controlId="new-project-source-branch"
                label="Source branch"
                hint="Changes are merged here first."
              >
                <input
                  id="new-project-source-branch"
                  className={inputClassName}
                  value={sourceBranch}
                  onChange={(event) => setSourceBranch(event.target.value)}
                  placeholder="develop"
                  required
                />
              </Field>
              <Field
                controlId="new-project-production-branch"
                label="Production branch"
                hint="Must be an ancestor of source."
              >
                <input
                  id="new-project-production-branch"
                  className={inputClassName}
                  value={productionBranch}
                  onChange={(event) => setProductionBranch(event.target.value)}
                  placeholder="main"
                  required
                />
              </Field>
            </div>

            {sourceBranch.trim() && sourceBranch.trim() === productionBranch.trim() ? (
              <p className="text-sm text-destructive">
                Source and production must be different branches.
              </p>
            ) : null}

            {mutation.isError ? (
              <p className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : 'Unable to create project'}
              </p>
            ) : null}

            <div className="flex justify-end gap-2 border-t pt-5">
              <Link to="/projects" className={buttonVariants({ variant: 'outline' })}>
                Cancel
              </Link>
              <Button type="submit" disabled={!canSubmit}>
                <GitBranch data-icon="inline-start" />
                {mutation.isPending ? 'Creating…' : 'Create project'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

function Field({
  controlId,
  label,
  hint,
  children,
}: {
  readonly controlId: string
  readonly label: string
  readonly hint?: string
  readonly children: ReactNode
}) {
  return (
    <div className="grid gap-2 text-sm font-medium">
      <label htmlFor={controlId}>{label}</label>
      {children}
      {hint ? <span className="font-normal text-muted-foreground">{hint}</span> : null}
    </div>
  )
}

const inputClassName =
  'h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-shadow focus:border-ring focus:ring-3 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50'
