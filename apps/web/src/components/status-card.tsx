import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

export type StatusState = 'loading' | 'operational' | 'unavailable'

interface StatusCardProps {
  readonly title: string
  readonly state: StatusState
  readonly description: string
  readonly children?: ReactNode
}

const labels: Record<StatusState, string> = {
  loading: 'Checking',
  operational: 'Operational',
  unavailable: 'Unavailable',
}

export function StatusCard({ title, state, description, children }: StatusCardProps) {
  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="text-base">{title}</CardTitle>

          {state === 'loading' ? (
            <Skeleton className="h-5 w-20" />
          ) : (
            <Badge variant={state === 'operational' ? 'default' : 'destructive'}>
              {labels[state]}
            </Badge>
          )}
        </div>

        <CardDescription>{description}</CardDescription>
      </CardHeader>

      {children ? (
        <CardContent className="text-sm text-muted-foreground">{children}</CardContent>
      ) : null}
    </Card>
  )
}
