import type { ReactNode } from 'react'
import type { Looked } from '@/api'
import { Age } from '@/components/Age'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'

/** `children` is called only in the `ok` branch, so a section physically
 *  cannot draw a table for a look that failed or has not happened. */
export function Section<T>({
  title,
  query,
  children,
}: {
  title: string
  query: Looked<T>
  children: (data: T) => ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {query.looked !== 'never' && (
          <CardDescription>
            <Age seconds={query.age_seconds} />
          </CardDescription>
        )}
      </CardHeader>
      <CardContent aria-live="polite">
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
      </CardContent>
    </Card>
  )
}
