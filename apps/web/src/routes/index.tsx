import { createFileRoute, redirect } from '@tanstack/react-router'

import { authSessionOptions } from '@/api/connection-queries'

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(authSessionOptions())

    throw redirect({
      to: session.authenticated ? '/installations' : '/login',
    })
  },
})
