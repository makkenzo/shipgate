import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Building2, ChevronRight, GitBranch, ShieldAlert } from 'lucide-react'

import type { InstallationSummary } from '@/api/connection'
import { installationsOptions } from '@/api/connection-queries'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAuthenticatedRoute } from '@/lib/auth-route'
import { toSafeHttpUrl } from '@/lib/safe-url'

export const Route = createFileRoute('/installations')({
  beforeLoad: ({ context }) => requireAuthenticatedRoute(context.queryClient),
  component: InstallationsPage,
})

function InstallationsPage() {
  const installations = useQuery(installationsOptions())

  if (installations.isError) {
    throw installations.error
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-muted-foreground">GitHub connection</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Installations</h1>
          <p className="mt-2 text-muted-foreground">
            Accounts and organizations where the Shipgate App is installed.
          </p>
        </div>

        <Link to="/setup" className={buttonVariants({ variant: 'outline' })}>
          <GitBranch data-icon="inline-start" />
          Add installation
        </Link>
      </div>

      {installations.isPending ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading installations…</p>
      ) : installations.data?.length === 0 ? (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>No GitHub App installation</CardTitle>
            <CardDescription>
              Install Shipgate before repositories can be discovered and verified.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link to="/setup" className={buttonVariants()}>
              Start setup
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-8 grid gap-4">
          {installations.data?.map((installation) => (
            <Link
              key={installation.id}
              to="/installations/$installationId"
              params={{ installationId: String(installation.id) }}
              className="group"
            >
              <Card className="transition-colors group-hover:bg-muted/30">
                <CardHeader>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
                        {toSafeHttpUrl(installation.owner.avatarUrl) ? (
                          <img
                            src={toSafeHttpUrl(installation.owner.avatarUrl)}
                            alt=""
                            className="size-full object-cover"
                          />
                        ) : (
                          <Building2 className="size-5" />
                        )}
                      </div>
                      <div>
                        <CardTitle>{installation.owner.login}</CardTitle>
                        <CardDescription className="mt-1">
                          {installation.repositoryCount} App repositories ·{' '}
                          {installation.userRepositoryCount} available to you
                        </CardDescription>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <InstallationStateBadge installation={installation} />
                      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  )
}

function InstallationStateBadge({ installation }: { readonly installation: InstallationSummary }) {
  if (installation.lifecycleState === 'pending_deletion') {
    return <Badge variant="secondary">Removing</Badge>
  }

  if (installation.lifecycleState === 'deleted') {
    return <Badge variant="secondary">Removed</Badge>
  }

  if (installation.lifecycleState === 'suspended') {
    return <Badge variant="destructive">Suspended</Badge>
  }

  if (installation.permissionUpgradePending) {
    return (
      <Badge variant="destructive">
        <ShieldAlert className="size-3" />
        Permission upgrade
      </Badge>
    )
  }

  if (installation.permissionState === 'stale') {
    return <Badge variant="secondary">Verifying</Badge>
  }

  return <Badge>Connected</Badge>
}
