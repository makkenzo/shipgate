import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { GitBranch, LockKeyhole } from 'lucide-react'

import { connectionConfigurationOptions } from '@/api/connection-queries'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { redirectAuthenticatedRoute } from '@/lib/auth-route'

export const Route = createFileRoute('/login')({
  beforeLoad: ({ context }) => redirectAuthenticatedRoute(context.queryClient),
  component: LoginPage,
})

function LoginPage() {
  const configuration = useQuery(connectionConfigurationOptions())

  if (configuration.isError) {
    throw configuration.error
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-lg items-center px-6 py-12">
      <Card className="w-full">
        <CardHeader className="space-y-4">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <GitBranch className="size-5" />
          </div>

          <div>
            <CardTitle className="text-xl">Connect Shipgate to GitHub</CardTitle>
            <CardDescription className="mt-2">
              Sign in with the GitHub account that can access the repositories you want Shipgate to
              manage.
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          <Button
            className="w-full"
            disabled={
              configuration.isPending ||
              configuration.isError ||
              !configuration.data?.githubLoginConfigured
            }
            onClick={() => {
              window.location.assign(configuration.data?.loginUrl ?? '/api/v1/auth/github')
            }}
          >
            <GitBranch data-icon="inline-start" />
            Continue with GitHub
          </Button>

          {!configuration.isPending && !configuration.data?.githubLoginConfigured ? (
            <p className="text-sm text-destructive">
              GitHub login is not configured for this Shipgate deployment.
            </p>
          ) : null}

          <div className="flex gap-3 rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
            <LockKeyhole className="mt-0.5 size-4 shrink-0" />
            <p>
              Shipgate stores an encrypted, expiring GitHub authorization and uses scoped
              installation tokens for repository operations.
            </p>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
