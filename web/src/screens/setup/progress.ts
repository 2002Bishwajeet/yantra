import { useQueries } from '@tanstack/react-query'
import type { Machine, Readiness } from '@/api'
import { useAbout, useGithub, useMachines, useReadiness, useSshIdentity, useWorkspaces } from '@/api/hooks'
import { machineReadinessQuery } from '@/api/queries'
import { runsSessions } from '@/lib/platform'
import { at } from '@/lib/time'
import { firstSession, github, isReady, line, machines as machinesStep, push, sshKey, tailnet } from './steps'

export const STEPS = 6

/** Each machine's newest report: a re-check where one was asked, else the
 *  sweep's. Nothing here reads a machine's key over the wire, so an unasked
 *  machine is unasked rather than a 404 (D3 §4.8). */
export function useReports(list: Machine[]): (Readiness | null)[] {
  const sweep = useReadiness()
  const asked = useQueries({
    queries: list.map((one) => ({ ...machineReadinessQuery(one.name), enabled: false })),
  })
  return list.map((machine, index) => {
    const own = asked[index]?.data
    if (own?.looked === 'ok') return own.data
    return sweep.looked === 'ok' ? (sweep.data.find((one) => one.machine === machine.name) ?? null) : null
  })
}

/** The owner's ruling (b), 2026-09-13: the checklist is `/` until the appliance
 *  has its key and one machine is ready. */
export function useSetupGate(machines: Machine[]) {
  const identity = useSshIdentity()
  const list = machines.filter(runsSessions)
  const reports = useReports(list)
  const ready = list.filter((one, index) => one.online && isReady(reports[index] ?? null)).length
  const key = identity.data ? 'made' : identity.data === null || identity.error ? 'missing' : 'reading'
  return { key, passed: key === 'made' && ready > 0 } as const
}

/** The six steps, as the checklist and the Finish setup card both read them. */
export function useChecklist(now: number) {
  const about = useAbout()
  const identity = useSshIdentity()
  const connection = useGithub()
  const machines = useMachines()
  const listed = useWorkspaces()
  const sweep = useReadiness()

  const all = machines.looked === 'ok' ? machines.data : []
  const list = all.filter(runsSessions)
  const reports = useReports(list)
  const lines = list.map((machine, index) => {
    const report = reports[index] ?? null
    const since = machine.last_seen ? (at(machine.last_seen, now)?.text ?? null) : null
    return { machine, report, line: line(machine, report, since) }
  })
  const readyCount = lines.filter((one) => one.line.kind === 'ready').length
  const steps = {
    tailnet: tailnet(about, location.protocol),
    ssh: sshKey(identity),
    machines: machinesStep(lines.map((one) => ({ machine: one.machine.name, line: one.line }))),
    github: github(connection),
    push: push(about),
    first: firstSession(listed.looked === 'ok' ? listed.data.length : null, readyCount),
  }
  const done = Object.values(steps).filter((one) => one.status === 'done').length
  const settled =
    !about.isPending &&
    !identity.isPending &&
    !connection.isPending &&
    machines.looked !== 'pending' &&
    listed.looked !== 'pending'
  return { about, identity, machines, sweep, all, lines, steps, done, readyCount, settled }
}

// Browser-local, like every preference (ADR-0024 §5), and under its own key
// because it is one fact and no screen edits it.
const DISMISSED = 'yantra.finish-setup'

export function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === 'dismissed'
  } catch {
    return false
  }
}

export function dismiss() {
  try {
    localStorage.setItem(DISMISSED, 'dismissed')
  } catch {
    // A private window keeps it for this page only, which the card's state does.
  }
}
