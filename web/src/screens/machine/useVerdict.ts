import { useState } from 'react'
import type { Machine, Readiness } from '@/api'
import type { Reading } from '@/api/client'
import { useNotifications } from '@/api/hooks'
import { asEvents } from '@/shell/notifications'
import type { Watch } from './install'
import { verdictOf } from './verdict'

/** The page's one piece of install state, and the verdict it decides. The
 *  header's chip reads the verdict too, so it lives above the card. */
export function useVerdict(name: string, machine: Machine | undefined, readiness: Reading<Readiness>) {
  const notifications = useNotifications()
  const events = asEvents(notifications.data)
  const [watch, setWatch] = useState<Watch | null>(null)
  const verdict = verdictOf({ name, machine, readiness, events, watch })
  return { verdict, events, watch, setWatch, notifications }
}

export type Verdicted = ReturnType<typeof useVerdict>
