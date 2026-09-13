import { useEffect, useState } from 'react'
import type { Event } from '@/api'
import { useInstall } from '@/api/mutations'
import { lastAsk, lastInstall } from './beats'

/** One machine's install, running from the press until an install event newer
 *  than the one before it arrives: the `202` says only that it started. The
 *  write is Y-396's `useInstall`, and the ring's own poll brings the event. */
export function useInstallOn(machine: string, events: Event[]) {
  const install = useInstall()
  const [since, setSince] = useState<number | null>(null)
  const last = lastInstall(events, machine)
  const running = install.isPending || (install.isSuccess && since !== null && last <= since)
  const press = () => {
    setSince(last)
    install.mutate(machine)
  }
  return { press, running, error: install.error }
}

/** One re-check per join or install seen arriving while the page is open. A
 *  person started each, and nothing here runs on a timer (ADR-0019). */
export function useAskOnArrival(machine: string, events: Event[], read: boolean, ask: (machine: string) => void) {
  const newest = lastAsk(events, machine)
  const [baseline, setBaseline] = useState<number | null>(null)
  if (baseline === null && read) setBaseline(newest)
  useEffect(() => {
    if (baseline !== null && newest > baseline) ask(machine)
  }, [ask, baseline, machine, newest])
}
