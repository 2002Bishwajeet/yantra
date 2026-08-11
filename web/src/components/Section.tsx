import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import type { Reading } from '@/useLooked'
import { Age } from '@/components/Age'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'

/** A group, which D3 §5.1 says is a heading, a rule and rows — never a card.
 *  Every section was a `Card` before Y-187, so every section weighed the same.
 *
 *  `children` is called only in the `ok` branch, so a section physically
 *  cannot draw a table for a look that failed or has not happened. */
export function Section<T>({
  title,
  query,
  waiting,
  children,
}: {
  title: string
  query: Reading<T>
  waiting?: string[]
  children: (data: T) => ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t pt-3">
        <h2 className="font-heading text-lg leading-snug font-medium">
          {title}
        </h2>
        {(query.looked === 'ok' || query.looked === 'failed') && (
          <span className="text-muted-foreground text-xs">
            <Age seconds={query.age_seconds} waiting={waiting} />
          </span>
        )}
      </div>
      <div aria-live="polite">
        {/* D3 §7.1: a read still in flight is not a daemon that never looked.
            React Query already separates the two; before Y-190 this drew both
            with the same sentence, so a first paint claimed nobody had looked. */}
        {query.looked === 'pending' && (
          <div className="flex flex-col gap-2" data-slot="reading">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
        )}
        {query.looked === 'never' && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Not looked at yet.</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        {query.looked === 'failed' && (
          <Alert variant="destructive">
            <AlertTitle>The look failed.</AlertTitle>
            {/* The whole source() chain, including a .toml parse error's line,
                column and caret — truncating it removes the actionable part. */}
            <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
              {query.error}
            </AlertDescription>
          </Alert>
        )}
        {query.looked === 'ok' && children(query.data)}
      </div>
    </section>
  )
}
