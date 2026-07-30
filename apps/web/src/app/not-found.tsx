import { Link } from '@tanstack/react-router'

import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-xl items-center px-6 py-10">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Page not found</CardTitle>

          <CardDescription>The requested Shipgate page does not exist.</CardDescription>
        </CardHeader>

        <CardContent>
          <Link to="/" className={buttonVariants()}>
            System status
          </Link>
        </CardContent>
      </Card>
    </main>
  )
}
