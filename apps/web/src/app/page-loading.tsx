import { Skeleton } from '@/components/ui/skeleton'

export function PageLoading() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="space-y-3">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-5 w-72" />
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
      </div>
    </main>
  )
}
