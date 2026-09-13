import { useQueries } from '@tanstack/react-query'
import type { Machine, Readiness } from '@/api'
import {
  useAbout,
  useGithub,
  useMachines,
  useNotifications,
  useReadiness,
  useSshIdentity,
  useWorkspaces,
} from '@/api/hooks'
import { machineReadinessQuery } from '@/api/queries'
import { runsSessions } from '@/lib/platform'
import { at } from '@/lib/time'
import { asEvents } from '@/shell/notifications'
import { added, firstSession, github, isReady, line, machines as readied, push, tailnet } from './steps'

/** D7 §4.1: four steps are required; GitHub and push wait for later. */
export const REQUIRED = 4

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

/** The next required thing, which is the page's one filled action (D7 §3.1). */
export type Next = 'add' | 'install' | 'session' | null

/** The checklist, as the page and the Finish setup card both read it. */
export function useChecklist(now: number) {
  const about = useAbout()
  const identity = useSshIdentity()
  const connection = useGithub()
  const machines = useMachines()
  const listed = useWorkspaces()
  const sweep = useReadiness()
  const notifications = useNotifications()
  const events = asEvents(notifications.data)

  const all = machines.looked === 'ok' ? machines.data : []
  const list = all.filter(runsSessions)
  const reports = useReports(list)
  const lines = list.map((machine, index) => {
    const report = reports[index] ?? null
    const since = machine.last_seen ? (at(machine.last_seen, now)?.text ?? null) : null
    return { machine, report, line: line(machine, report, since) }
  })
  // A join is its event, or ssh already getting in after a restart forgot it.
  const joined = lines
    .filter(
      ({ machine, report }) =>
        events.some((one) => one.kind === 'joined' && one.machine === machine.name) ||
        report?.checks.some((one) => one.check === 'reachable' && one.state === 'present'),
    )
    .map((one) => one.machine.name)
  const readyCount = lines.filter((one) => one.line.kind === 'ready').length

  const steps = {
    tailnet: tailnet(about, location.protocol),
    machine: added(joined),
    ready: readied(lines.map((one) => ({ machine: one.machine.name, line: one.line }))),
    first: firstSession(listed.looked === 'ok' ? listed.data.length : null, readyCount),
  }
  const later = { github: github(connection), push: push(about) }
  const done = Object.values(steps).filter((one) => one.status === 'done').length
  const target =
    lines.find((one) => one.line.kind === 'missing' && one.line.installable)?.machine.name ?? null
  const next: Next =
    steps.machine.status !== 'done'
      ? 'add'
      : steps.ready.status !== 'done'
        ? target
          ? 'install'
          : null
        : steps.first.status !== 'done'
          ? 'session'
          : null
  const settled =
    !about.isPending &&
    !identity.isPending &&
    !connection.isPending &&
    machines.looked !== 'pending' &&
    listed.looked !== 'pending'
  return {
    about,
    identity,
    machines,
    sweep,
    notifications,
    events,
    all,
    lines,
    steps,
    later,
    done,
    readyCount,
    next,
    target,
    settled,
  }
}
