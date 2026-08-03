import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ExternalLink, LogOut, Trash2, Unplug } from 'lucide-react'

import { deleteLocalAccount, disconnectGitHub, logout } from '@/api/connection'
import { authSessionOptions } from '@/api/connection-queries'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAuthenticatedRoute } from '@/lib/auth-route'
import { toSafeHttpUrl } from '@/lib/safe-url'

export const Route = createFileRoute('/account')({
  beforeLoad: ({ context }) => requireAuthenticatedRoute(context.queryClient),
  component: AccountPage,
})

function AccountPage() {
  const session = useQuery(authSessionOptions())
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const finishSessionMutation = async () => {
    await queryClient.cancelQueries()
    queryClient.clear()
    await navigate({ to: '/login' })
  }

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: finishSessionMutation,
  })
  const disconnectMutation = useMutation({
    mutationFn: disconnectGitHub,
    onSuccess: finishSessionMutation,
  })
  const deleteMutation = useMutation({
    mutationFn: deleteLocalAccount,
    onSuccess: finishSessionMutation,
  })

  if (!session.data?.authenticated) {
    return null
  }

  const user = session.data.user
  const avatarUrl = toSafeHttpUrl(user.avatarUrl)
  const profileUrl = toSafeHttpUrl(user.htmlUrl)
  const pending =
    logoutMutation.isPending || disconnectMutation.isPending || deleteMutation.isPending

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Settings</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Account</h1>
      </div>

      <Card className="mt-8">
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="flex size-12 items-center justify-center overflow-hidden rounded-xl bg-muted">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                <span className="text-lg font-semibold">
                  {user.login.slice(0, 1).toUpperCase()}
                </span>
              )}
            </div>
            <div>
              <CardTitle>{user.displayName ?? user.login}</CardTitle>
              <CardDescription className="mt-1">@{user.login}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {profileUrl ? (
            <a
              href={profileUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              Open GitHub profile <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>
            Sign out from this browser without revoking the GitHub authorization.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" disabled={pending} onClick={() => logoutMutation.mutate()}>
            <LogOut data-icon="inline-start" />
            Sign out
          </Button>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>GitHub connection</CardTitle>
          <CardDescription>
            Revoke the GitHub user authorization and every active Shipgate session. Installation
            records remain available for audit and can be reconnected later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              if (window.confirm('Disconnect GitHub and revoke all Shipgate sessions?')) {
                disconnectMutation.mutate()
              }
            }}
          >
            <Unplug data-icon="inline-start" />
            Disconnect GitHub
          </Button>
        </CardContent>
      </Card>

      <Card className="mt-4 ring-destructive/30">
        <CardHeader>
          <CardTitle>Delete local account</CardTitle>
          <CardDescription>
            Permanently remove the local Shipgate user record, user repository access snapshots,
            credentials, and sessions. The GitHub grant itself is left untouched; disconnect it
            first when you also want to revoke the authorization on GitHub.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              if (
                window.confirm(
                  'Permanently delete your local Shipgate account? This cannot be undone.',
                )
              ) {
                deleteMutation.mutate()
              }
            }}
          >
            <Trash2 data-icon="inline-start" />
            Delete local account
          </Button>
        </CardContent>
      </Card>

      {logoutMutation.isError || disconnectMutation.isError || deleteMutation.isError ? (
        <p className="mt-4 text-sm text-destructive">
          The account operation failed. Reload the page and try again.
        </p>
      ) : null}
    </main>
  )
}
