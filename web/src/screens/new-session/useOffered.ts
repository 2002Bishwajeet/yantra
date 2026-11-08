import { useMachines, useReadiness } from '@/api/hooks'
import { useReports } from '@/screens/setup/progress'
import { runsSessions } from '@/lib/platform'
import { offered } from './form'

/** Machines whose chip may be drawn (Y-627): yours, and a system that runs a session. `waiting` is a readiness read still in flight
 *  that a hub's chip depends on; with no hub nothing waits. */
export function useOffered() {
  const machines = useMachines()
  const yours = machines.looked === 'ok' ? machines.data.filter(runsSessions) : []
  const shown = offered(yours, useReports(yours))
  return { yours, shown, waiting: useReadiness().looked === 'pending' && yours.some((one) => one.hub) }
}
