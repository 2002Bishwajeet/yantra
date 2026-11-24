import { useMachines, useReadiness } from '@/api/hooks'
import { useReports } from '@/screens/setup/progress'
import { runsSessions } from '@/lib/platform'
import { offered } from './form'

/** Machines whose chip may be drawn (Y-627): yours, and a system that runs a session. `waiting` is a readiness read still in flight
 *  that a hub's chip depends on; with no hub nothing waits. `checking` is the hub while the daemon's check of it at start
 *  still runs (Y-830): readiness says `never`, and no report names the hub. */
export function useOffered() {
  const machines = useMachines()
  const readiness = useReadiness().looked
  const yours = machines.looked === 'ok' ? machines.data.filter(runsSessions) : []
  const reports = useReports(yours)
  const shown = offered(yours, reports)
  const checking = readiness === 'never' ? (yours.find((one, index) => one.hub && !reports[index]) ?? null) : null
  return { yours, shown, checking, waiting: readiness === 'pending' && yours.some((one) => one.hub) }
}
