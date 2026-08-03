import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { CheckCircle2, GitBranch, PlugZap } from 'lucide-react'

import { connectionConfigurationOptions, installationsOptions } from '@/api/connection-queries'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAuthenticatedRoute } from '@/lib/auth-route'
import { toSafeHttpUrl } from '@/lib/safe-url'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/setup')({
  beforeLoad: ({ context }) => requireAuthenticatedRoute(context.queryClient),
  component: SetupPage,
})

function SetupPage() {
  const configuration = useQuery(connectionConfigurationOptions())
  const installations = useQuery(installationsOptions())
  const connected = (installations.data?.length ?? 0) > 0
  const installUrl = toSafeHttpUrl(configuration.data?.installUrl)

  if (configuration.isError) {
    throw configuration.error
  }

  if (installations.isError) {
    throw installations.error
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <div className="mb-8">
        <p className="text-sm font-medium text-muted-foreground">Connection setup</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Install the Shipgate GitHub App
        </h1>
        <p className="mt-3 max-w-xl text-muted-foreground">
          The App installation grants repository access. Your user authorization is checked
          separately, so Shipgate only shows repositories available to both.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start gap-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
              {connected ? <CheckCircle2 className="size-5" /> : <PlugZap className="size-5" />}
            </div>
            <div>
              <CardTitle>{connected ? 'GitHub App connected' : 'No installation found'}</CardTitle>
              <CardDescription className="mt-1">
                {connected
                  ? `${installations.data?.length ?? 0} installation${installations.data?.length === 1 ? '' : 's'} connected.`
                  : 'Install the App on your account or organization, then GitHub will return you here.'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-3 sm:flex-row">
          {connected ? (
            <Link to="/installations" className={buttonVariants()}>
              View installations
            </Link>
          ) : (
            <a
              href={installUrl}
              className={cn(
                buttonVariants(),
                (!installUrl || configuration.isPending) && 'pointer-events-none opacity-50',
              )}
            >
              <GitBranch data-icon="inline-start" />
              Install GitHub App
            </a>
          )}

          <Link to="/account" className={buttonVariants({ variant: 'outline' })}>
            Account settings
          </Link>
        </CardContent>
      </Card>

      {!connected &&
      !configuration.isPending &&
      !configuration.data?.githubInstallationConfigured ? (
        <p className="mt-4 text-sm text-destructive">
          GITHUB_APP_SLUG is not configured, so Shipgate cannot build the installation URL.
        </p>
      ) : null}
    </main>
  )
}
