import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Event } from '@/api'
import { request } from '@/api/client'
import type { ApiError } from '@/api/errors'
import { keys } from '@/api/keys'
import { lastAsk, lastInstall } from './beats'

/** `POST /api/machines/{m}/install` answers `202` and nothing else
 *  (ADR-0028 §4). What it did arrives later as an `installed` or
 *  `install_stopped` event, so the ring is what is asked again. A `409` is an
 *  install already running there. Here until Y-396's lands in
 *  `api/mutations.ts` (D7 T3). */
export function useInstall() {
  const client = useQueryClient()
  return useMutation<void, ApiError, string>({
    mutationFn: async (machine) => {
      await request(`/api/machines/${encodeURIComponent(machine)}/install`, { method: 'POST' })
    },
    onSuccess: () => client.invalidateQueries({ queryKey: keys.notifications() }),
  })
}

/** One machine's install, running from the press until an install event newer
 *  than the one before it arrives: the `202` says only that it started. */
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
