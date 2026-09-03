import { Link } from '@tanstack/react-router'
import { Ago } from '@/components/Age'
import type { Reading } from '@/useLooked'

// One refresh period. A read this far behind the rest is not the same reading.
const BEHIND = 30

export type Read = { name: string; reading: Reading<unknown> }

/** D3 §4.3, one line at the foot of the work page. It replaces the seven
 *  freshness stamps §2 finding 4 counted, where D1 §2 had asked for one.
 *
 *  **The age is the oldest read, never an average**, because an average hides
 *  the one stale answer — which is the failure `Age` exists to prevent. A read
 *  more than one refresh period behind the rest is named beside the figure
 *  rather than folded into it, so `as of 4s · readiness 51s` says both things. */
export function Footer({
  reads,
  machines,
  unreachable,
  unclaimed,
}: {
  reads: Read[]
  machines: number | null
  unreachable: number
  unclaimed: number | null
}) {
  const aged = reads.flatMap((read) =>
    read.reading.looked === 'ok' || read.reading.looked === 'failed'
      ? [{ name: read.name, age: read.reading.age_seconds }]
      : [],
  )
  if (aged.length === 0) return null

  const youngest = Math.min(...aged.map((one) => one.age))
  const late = aged.filter((one) => one.age - youngest > BEHIND)
  const rest = aged.filter((one) => one.age - youngest <= BEHIND)

  return (
    <p className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
      {machines !== null && (
        <span>
          {machines} machine{machines === 1 ? '' : 's'}
        </span>
      )}
      {unreachable > 0 && <span>· {unreachable} unreachable</span>}
      {/* A session no workspace claims is holding a machine and nothing else in
          Yantra will mention it, so the work page counts it without giving it a
          group. */}
      {unclaimed !== null && unclaimed > 0 && (
        <span>
          ·{' '}
          <Link to="/machines">
            {unclaimed} session{unclaimed === 1 ? '' : 's'} unclaimed
          </Link>
        </span>
      )}
      <span>
        · as of <Ago seconds={Math.max(...rest.map((one) => one.age))} />
      </span>
      {late.map((one) => (
        <span key={one.name}>
          · {one.name} <Ago seconds={one.age} />
        </span>
      ))}
    </p>
  )
}
