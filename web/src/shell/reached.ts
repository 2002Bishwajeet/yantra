import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { NOT_REACHED, REFUSED, type Reading, Unanswered } from '@/api/client'
import { machinesQuery, sessionsQuery, workspacesQuery } from '@/api/queries'
import { unreachable } from '@/work'

/** D3 §7.2 raised to the shell. `unreachable` collapses N identical failures
 *  into one; this keeps the ones that happened before the daemon answered, and
 *  the daemon refusing this device, because a daemon that answered and said its
 *  own look failed is news about the fleet and belongs on the screen that owns it. */
export function notReached(reads: Reading<unknown>[]): string | null {
  const same = unreachable(reads)
  return same !== null && (same.startsWith(NOT_REACHED) || same.startsWith(REFUSED)) ? same : null
}

/** The three classes every screen under the shell draws from, and the instant
 *  the last good look landed — which is all the board can say about the age of
 *  the fleet it is refusing to draw.
 *
 *  They are read through `useQuery` rather than the reading hooks. Query holds
 *  `dataUpdatedAt`, so the render reads no clock of its own. Query also holds
 *  the `Unanswered` of a read that kept its reading (Y-744): `reconnecting` is
 *  a page still drawn from readings the daemon has stopped renewing. */
export function useReached() {
  const machines = useQuery(machinesQuery())
  const reads = [machines, useQuery(workspacesQuery()), useQuery(sessionsQuery())]
  const why = notReached(reads.map((one): Reading<unknown> => one.data ?? { looked: 'pending' }))
  const reconnecting = why === null && reads.some((one) => one.error instanceof Unanswered)
  const [since, setSince] = useState<number | null>(null)
  const at = machines.data?.looked === 'ok' ? machines.dataUpdatedAt : null
  if (at !== null && at !== since) setSince(at)
  return { why, since, reconnecting }
}
