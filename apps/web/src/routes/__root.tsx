import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'

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
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center px-6">
          <span className="text-lg font-semibold tracking-tight">Shipgate</span>
        </div>
      </header>

      <Outlet />
    </div>
  )
}
