import type { ReactNode } from 'react'
import type { Looked } from '@/api'
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
  query: Looked<T>
  waiting?: string[]
  children: (data: T) => ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t pt-3">
        <h2 className="font-heading text-lg leading-snug font-medium">
          {title}
        </h2>
        {query.looked !== 'never' && (
          <span className="text-muted-foreground text-xs">
            <Age seconds={query.age_seconds} waiting={waiting} />
          </span>
        )}
      </div>
      <div aria-live="polite">
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
