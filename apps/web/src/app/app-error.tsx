import type { ErrorComponentProps } from '@tanstack/react-router'

import { normalizeApiError } from '@/api/api-error'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function AppErrorBoundary({ error, reset }: ErrorComponentProps) {
  const apiError = normalizeApiError(error)

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-xl items-center px-6 py-10">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>

          <CardDescription>{apiError.message}</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {apiError.requestId ? (
            <p className="text-sm text-muted-foreground">
              Request ID: <code>{apiError.requestId}</code>
            </p>
          ) : null}

          <div className="flex gap-3">
            <Button onClick={reset}>Try again</Button>

            <Button
              variant="outline"
              onClick={() => {
                window.location.assign('/')
              }}
            >
              Go home
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
