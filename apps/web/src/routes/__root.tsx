import { useQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'
import { GitBranch } from 'lucide-react'

import { authSessionOptions } from '@/api/connection-queries'
import { AppErrorBoundary } from '@/app/app-error'
import { NotFoundPage } from '@/app/not-found'
import { PageLoading } from '@/app/page-loading'
import type { RouterContext } from '@/router-context'

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: AppErrorBoundary,
  notFoundComponent: NotFoundPage,
  pendingComponent: PageLoading,
})

function RootLayout() {
  const session = useQuery(authSessionOptions())
  const authenticated = session.data?.authenticated === true

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <GitBranch className="size-4" />
            </span>
            Shipgate
          </Link>

          {authenticated ? (
            <nav className="flex items-center gap-5 text-sm">
              <Link
                to="/installations"
                className="text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground"
              >
                Installations
              </Link>
              <Link
                to="/account"
                className="text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground"
              >
                Account
              </Link>
            </nav>
          ) : null}
        </div>
      </header>

      <Outlet />
    </div>
  )
}
