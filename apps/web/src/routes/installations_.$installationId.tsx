import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  ExternalLink,
  GitBranch,
  KeyRound,
  Lock,
  ShieldAlert,
  UserRoundX,
} from 'lucide-react'

import { installationOptions } from '@/api/connection-queries'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAuthenticatedRoute } from '@/lib/auth-route'
import { toSafeHttpUrl } from '@/lib/safe-url'

export const Route = createFileRoute('/installations_/$installationId')({
  beforeLoad: ({ context }) => requireAuthenticatedRoute(context.queryClient),
  component: InstallationPage,
})

function InstallationPage() {
  const { installationId } = Route.useParams()
  const numericInstallationId = Number(installationId)
  const installationIdIsValid =
    Number.isSafeInteger(numericInstallationId) && numericInstallationId > 0
  const installation = useQuery(installationOptions(numericInstallationId, installationIdIsValid))

  if (!installationIdIsValid) {
    throw new Error('Installation ID is invalid')
  }

  if (installation.isPending) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-10 text-sm text-muted-foreground">
        Loading installation…
      </main>
    )
  }

  if (!installation.data) {
    throw installation.error ?? new Error('Installation could not be loaded')
  }

  const missingPermissions = installation.data.permissions.filter(
    (permission) => !permission.satisfied,
  )
  const installationRemoved =
    installation.data.lifecycleState === 'pending_deletion' ||
    installation.data.lifecycleState === 'deleted'
  const avatarUrl = toSafeHttpUrl(installation.data.owner.avatarUrl)
  const manageUrl = toSafeHttpUrl(installation.data.manageUrl)

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link
        to="/installations"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Installations
      </Link>

      <div className="mt-6 flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
        <div className="flex items-start gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="size-full object-cover" />
            ) : (
              <GitBranch className="size-5" />
            )}
          </div>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              {installation.data.owner.login}
            </h1>
            <p className="mt-2 text-muted-foreground">
              Installation #{installation.data.id} · {installation.data.repositorySelection}{' '}
              repositories
            </p>
          </div>
        </div>

        {manageUrl ? (
          <a
            href={manageUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'outline' })}
          >
            Manage on GitHub
            <ExternalLink data-icon="inline-end" />
          </a>
        ) : null}
      </div>

      {installationRemoved ? (
        <Notice
          title="Installation removed"
          description="GitHub access has been closed. Shipgate is retaining the local identity only until lifecycle cleanup completes."
        />
      ) : null}

      {!installationRemoved && installation.data.lifecycleState === 'suspended' ? (
        <Notice
          title="Installation suspended"
          description="GitHub jobs are blocked until the installation is unsuspended and access is reconciled."
        />
      ) : null}

      {!installationRemoved &&
      installation.data.permissionState === 'stale' &&
      missingPermissions.length === 0 ? (
        <Notice
          title="Access verification pending"
          description="Shipgate has received a lifecycle change and is waiting for repository access reconciliation."
        />
      ) : null}

      {!installationRemoved && missingPermissions.length > 0 ? (
        <Notice
          title="Permission upgrade pending"
          description={`The installation is missing ${missingPermissions
            .map((permission) => `${permission.name}:${permission.required}`)
            .join(', ')}. Repository operations requiring these permissions remain blocked.`}
        />
      ) : null}

      <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card>
          <CardHeader>
            <CardTitle>Repositories</CardTitle>
            <CardDescription>
              Repositories visible to the App, with the current user permission shown separately.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {installation.data.repositories.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No repositories are currently available to this installation.
              </p>
            ) : (
              <div className="divide-y">
                {installation.data.repositories.map((repository) => (
                  <div
                    key={repository.id}
                    className="flex flex-col justify-between gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {repository.private ? (
                          <Lock className="size-4 text-muted-foreground" />
                        ) : (
                          <GitBranch className="size-4 text-muted-foreground" />
                        )}
                        <p className="truncate font-medium">{repository.fullName}</p>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Default branch: {repository.defaultBranch ?? 'not reported'}
                      </p>
                    </div>

                    {repository.accessibleToUser ? (
                      <Badge
                        variant={
                          hasWriteAccess(repository.userPermission) ? 'default' : 'secondary'
                        }
                      >
                        <KeyRound className="size-3" />
                        {repository.userPermission}
                      </Badge>
                    ) : (
                      <Badge variant="destructive">
                        <UserRoundX className="size-3" />
                        No user access
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>App permissions</CardTitle>
            <CardDescription>Installed versus required permission levels.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {installation.data.permissions.map((permission) => (
              <div
                key={permission.name}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="truncate">{permission.name}</span>
                <Badge variant={permission.satisfied ? 'outline' : 'destructive'}>
                  {permission.actual ?? 'missing'} / {permission.required}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

function Notice({ title, description }: { readonly title: string; readonly description: string }) {
  return (
    <div className="mt-6 flex gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
      <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

function hasWriteAccess(permission: string): boolean {
  return permission === 'write' || permission === 'maintain' || permission === 'admin'
}
