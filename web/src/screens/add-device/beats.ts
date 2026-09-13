import type { Check, Event, Machine, Readiness } from '@/api'
import type { Reading } from '@/api/hooks'
import { platformOf, type Platform } from '@/lib/platform'
import { INSTALLED, isReady, word } from '@/screens/setup/steps'

/** Walk-through §3.2: every beat is seen by the appliance, never declared.
 *  `ahead` is a beat whose turn has not come. */
export type BeatState = 'ahead' | 'waiting' | 'done' | 'stuck'

export type Beat = {
  state: BeatState
  words: string
  /** A read or a write this page made that failed, drawn as its surface. */
  error?: Error
  /** The commands an install left for a person, each run verbatim (Y-386). */
  commands?: string[]
}

/** A person's ask or install, as the page holds it. */
export type Asked = { pending: boolean; error: Error | null }

/** D7 §4.2: a beat that has waited this long is stuck, and says what to check. */
export const LATE_MS = 3 * 60_000

const noun: Record<Platform, string> = {
  linux: 'Linux machine',
  macos: 'Mac',
  mobile: 'phone or tablet',
  windows: 'Windows machine',
}

const check = (report: Readiness | null, name: string): Check | undefined =>
  report?.checks.find((one) => one.check === name)

/** The daemon serves the ring newest first, so the first match is the newest. */
const newest = (events: Event[], name: string, kinds: Event['kind'][]) =>
  events.find((one) => one.machine === name && kinds.includes(one.kind)) ?? null

/** The first node of this platform that was not on the tailnet when the flow
 *  opened: the device the person is adding. */
export const newDevice = (list: Machine[], seen: string[] | null, platform: Platform) =>
  seen === null ? undefined : list.find((one) => platformOf(one) === platform && !seen.includes(one.name))?.name

/** Beat 1, read on the device already open: the node in the inventory the
 *  daemon serves. */
export function onTailnet(
  machines: Reading<Machine[]>,
  name: string | undefined,
  platform: Platform,
  late: boolean,
): Beat & { machine: Machine | null } {
  if (machines.looked === 'failed') return { state: 'stuck', words: 'the tailnet list could not be read', machine: null }
  if (machines.looked !== 'ok') return { state: 'waiting', words: 'reading the tailnet…', machine: null }
  if (!name) {
    return late
      ? {
          state: 'stuck',
          words: `Not seen yet. Check that the ${noun[platform]} logged in to Tailscale with the same account as the appliance.`,
          machine: null,
        }
      : { state: 'waiting', words: `watching the tailnet for a new ${noun[platform]}`, machine: null }
  }
  const machine = machines.data.find((one) => one.name === name) ?? null
  if (!machine) {
    return { state: 'stuck', words: `the tailnet lists no device called ${name} · pick the device again`, machine }
  }
  if (machine.expired) {
    return { state: 'stuck', words: `${name} is on the tailnet and its Tailscale key has expired · log in to Tailscale there again`, machine }
  }
  if (!machine.online) {
    return { state: 'stuck', words: `${name} is on the tailnet and offline now · wake it, or start Tailscale there`, machine }
  }
  return { state: 'done', words: `${name} is on the tailnet`, machine }
}

/** Beat 2: the `joined` event. The owner ruled the page says when ssh logs in
 *  as another account, or a block was kept (ADR-0029). */
export function joined(
  name: string,
  events: Event[],
  eventsError: Error | null,
  report: Readiness | null,
  late: boolean,
): Beat {
  const join = newest(events, name, ['joined'])
  if (join) {
    const reply = join.joined ?? null
    if (reply && reply.logs_in_as !== reply.user) {
      return {
        state: 'stuck',
        words: `joined as ${reply.user}, and ssh logs in as ${reply.logs_in_as ?? 'an account Yantra could not read'}${reply.kept ? '; a config you wrote was kept' : ''}`,
      }
    }
    if (!reply) return { state: 'done', words: join.said }
    return {
      state: 'done',
      words: `joined as ${reply.user}${reply.kept ? ' · the ssh config already named it with that account, so it was kept' : ''}`,
    }
  }
  if (check(report, 'reachable')?.state === 'present') {
    return { state: 'done', words: 'joined earlier · Yantra already reaches it over ssh' }
  }
  if (eventsError) return { state: 'stuck', words: "the daemon's events could not be read, so a join cannot be seen", error: eventsError }
  if (late) return { state: 'stuck', words: `No join yet. Is curl there? The command must run on ${name} itself.` }
  return { state: 'waiting', words: `run this in a terminal on ${name}` }
}

/** Beat 3: readiness answers `reachable`, which only a running `sshd` can. */
export function reachable(
  before: Beat,
  name: string,
  report: Readiness | null,
  events: Event[],
  ask: Asked,
  platform: Platform,
): Beat {
  if (before.state !== 'done') return { state: 'ahead', words: 'waits for the join' }
  const reach = check(report, 'reachable')
  if (reach?.state === 'present') return { state: 'done', words: 'reachable over ssh' }
  if (ask.pending) return { state: 'waiting', words: `Yantra is checking ${name} over ssh` }
  if (ask.error) return { state: 'stuck', words: `${name} was not asked`, error: ask.error }
  const hint = platform === 'macos' ? ' · check that Remote Login is on' : ''
  if (reach) return { state: 'stuck', words: `${reach.detail}${hint}` }
  const since = newest(events, name, ['joined'])?.at ?? 0
  const lost = events.find((one) => one.machine === name && one.kind === 'unreachable' && one.at >= since)
  if (lost) return { state: 'stuck', words: `${lost.said}${hint}` }
  return { state: 'waiting', words: `Yantra checks ${name} over ssh once it joins · Check asks now` }
}

/** What Install would put there that is not there yet. */
export const installable = (report: Readiness | null) =>
  INSTALLED.some((one) => check(report, one)?.state !== 'present')

function missing(report: Readiness | null): string {
  const absent = report?.checks.filter((one) => one.state === 'absent').map((one) => word(one.check)) ?? []
  const unknown = report?.checks.filter((one) => one.state === 'unknown').map((one) => word(one.check)) ?? []
  return [absent.length ? `missing ${absent.join(', ')}` : '', unknown.length ? `could not ask about ${unknown.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ')
}

/** Beat 4: an `installed` event, or all ten checks present (D7 §4.2). */
export function ready(before: Beat, name: string, report: Readiness | null, events: Event[], ask: Asked, install: Asked): Beat {
  if (before.state !== 'done') return { state: 'ahead', words: 'waits for ssh' }
  const last = newest(events, name, ['installed', 'install_stopped'])
  if (isReady(report) || (last?.kind === 'installed' && !installable(report))) {
    return { state: 'done', words: `ready · open a session on ${name}` }
  }
  if (install.pending) return { state: 'waiting', words: 'installing… it can take minutes, and this ticks when it ends' }
  if (install.error) return { state: 'stuck', words: `the install on ${name} did not start`, error: install.error }
  if (ask.pending) return { state: 'waiting', words: `asking ${name} again…` }
  if (ask.error) return { state: 'stuck', words: `${name} was not asked`, error: ask.error }
  if (last?.kind === 'install_stopped' && installable(report)) {
    return { state: 'stuck', words: last.said, commands: last.commands }
  }
  if (installable(report)) return { state: 'waiting', words: `${missing(report)} · Install adds tmux, git and claude` }
  return { state: 'waiting', words: `${missing(report)} · the machine page shows how to fix these` }
}

/** What the page re-asks after: a join or an install it saw arrive. */
export const lastAsk = (events: Event[], name: string) =>
  newest(events, name, ['joined', 'installed', 'install_stopped'])?.at ?? 0

/** Where a new install's event will land: the newest one before it. */
export const lastInstall = (events: Event[], name: string) =>
  newest(events, name, ['installed', 'install_stopped'])?.at ?? 0
