import type { Attention, Item } from '@/api'
import { Ago, Stamp } from '@/components/Age'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import type { Reading } from '@/useLooked'
import { speaks } from '@/work'

/** D3 §14 and D6 §3: a block inside `Needs you` under its own `h3`, below the
 *  workspace rows, because a crashed agent on your own fleet is more urgent
 *  than a review request. Its verbs open GitHub and nothing else. */
export function AttentionBand({ reading }: { reading: Reading<Attention> }) {
  if (!speaks(reading)) return null

  return (
    <section className="flex flex-col gap-2 pt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-heading text-sm font-medium">GitHub</h3>
        {(reading.looked === 'ok' || reading.looked === 'failed') && (
          // Not `Age`, whose stale thresholds are the 30 s sweep's: at this
          // cadence a two-minute-old answer is on time. So the band names the
          // clock beside the figure (D6 §2, `refresh.rs`'s ATTENTION).
          <span className="text-muted-foreground text-xs">
            as of <Ago seconds={reading.age_seconds} /> · read every 5 min
          </span>
        )}
      </div>
      <div aria-live="polite">
        {reading.looked === 'pending' && (
          <div className="flex flex-col gap-2" data-slot="reading">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
        )}
        {reading.looked === 'never' && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Not looked at yet.</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        {reading.looked === 'failed' && (
          <Alert variant="destructive">
            <AlertTitle>GitHub could not be read.</AlertTitle>
            {/* Every reason `attention.rs` tells apart is already written as an
                instruction, so the daemon's own text is what a reader needs. */}
            <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
              {reading.error}
            </AlertDescription>
          </Alert>
        )}
        {reading.looked === 'ok' && (
          <div className="flex flex-col gap-2">
            <List items={reading.data.reviews} title="review requested" />
            <List items={reading.data.issues} title="assigned to you" />
            <Unread count={reading.data.notifications} />
          </div>
        )}
      </div>
    </section>
  )
}

// One line, and the titles never cross the wire to reach it (D6 §3.3).
function Unread({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <a
      className="text-sm"
      href="https://github.com/notifications"
      rel="noreferrer"
      target="_blank"
    >
      {count} unread notification{count === 1 ? '' : 's'}
    </a>
  )
}

/** Two lists rather than one with a badge: which list an item is in is its
 *  kind, and a badge would re-encode what the heading already says. */
function List({ items, title }: { items: Item[]; title: string }) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      <h4 className="text-muted-foreground text-xs">{title}</h4>
      <ul>
        {items.map((item) => (
          <li key={item.url}>
            {/* The link is the row, and its href is GitHub's own URL. */}
            <a
              className="flex min-h-14 items-center gap-x-3 py-1 md:min-h-10"
              href={item.url}
              rel="noreferrer"
              target="_blank"
            >
              <span className="font-mono text-xs">
                {item.repo}#{item.number}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">
                {item.title}
              </span>
              {/* GitHub's age, which is the pull request's rather than the
                  answer's — the two mean different things (D6 §2). */}
              <span className="text-muted-foreground text-xs">
                <Stamp stamp={item.updated_at} />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
