import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { NOT_REACHED, type Reading } from '@/api/client'
import { useSessions, useWorkspaces } from '@/api/hooks'
import { machinesQuery } from '@/api/queries'
import { unreachable } from '@/work'

/** D3 §7.2 raised to the shell. `unreachable` collapses N identical failures
 *  into one; this keeps only the ones that happened before the daemon
 *  answered, because a daemon that answered and said its own look failed is
 *  news about the fleet and belongs on the screen that owns it. */
export function notReached(reads: Reading<unknown>[]): string | null {
  const same = unreachable(reads)
  return same !== null && same.startsWith(NOT_REACHED) ? same : null
}

/** The three classes every screen under the shell draws from, and the instant
 *  the last good look landed — which is all the board can say about the age of
 *  the fleet it is refusing to draw.
 *
 *  The machines class is read through `useQuery` rather than `useMachines` for
 *  `dataUpdatedAt`: Query already holds that instant, so the render reads no
 *  clock of its own. */
export function useReached() {
  const machines = useQuery(machinesQuery())
  const reading: Reading<unknown> = machines.data ?? { looked: 'pending' }
  const why = notReached([reading, useWorkspaces(), useSessions()])
  const [since, setSince] = useState<number | null>(null)
  const at = reading.looked === 'ok' ? machines.dataUpdatedAt : null
  if (at !== null && at !== since) setSince(at)
  return { why, since }
}
