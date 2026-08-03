import type { QueryClient } from '@tanstack/react-query'
import { redirect } from '@tanstack/react-router'

import { authSessionOptions } from '@/api/connection-queries'

export async function requireAuthenticatedRoute(queryClient: QueryClient): Promise<void> {
  const session = await queryClient.ensureQueryData(authSessionOptions())

  if (!session.authenticated) {
    throw redirect({
      to: '/login',
    })
  }
}

export async function redirectAuthenticatedRoute(queryClient: QueryClient): Promise<void> {
  const session = await queryClient.ensureQueryData(authSessionOptions())

  if (session.authenticated) {
    throw redirect({
      to: '/installations',
    })
  }
}
