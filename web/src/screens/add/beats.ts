import type { Check, Event, Machine, Readiness } from '@/api'
import type { Reading } from '@/api/hooks'
import { platformOf, type Platform } from '@/lib/platform'
import { word } from '@/screens/setup/steps'

/** Walk-through §3.2: every beat is seen by the appliance, never declared. */
export type BeatState = 'waiting' | 'done' | 'stuck'

export type Beat = {
  state: BeatState
  words: string
  /** A write or a read this page made that failed, drawn as its surface. */
  error?: Error
  /** The commands an install left for a person, each run verbatim (Y-386). */
  commands?: string[]
}

/** A person's ask or install, as the page holds it. */
export type Asked = { pending: boolean; error: Error | null }

const noun: Record<Platform, string> = {
  linux: 'Linux machine',
  macOS: 'Mac',
  phone: 'phone or tablet',
  windows: 'Windows machine',
}

const TOOLS = ['tmux', 'git', 'agent-cli'] as const

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
): Beat & { machine: Machine | null } {
  if (machines.looked === 'failed') {
    return { state: 'stuck', words: `the tailnet list could not be read · ${machines.error}`, machine: null }
  }
  if (machines.looked !== 'ok') return { state: 'waiting', words: 'reading the tailnet…', machine: null }
  if (!name) {
    return {
      state: 'waiting',
      words: `waiting for a new ${noun[platform]} on the tailnet · log in to Tailscale there with the same account as the appliance`,
      machine: null,
    }
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
  return { state: 'done', words: `${name} is on the tailnet as ${machine.os}`, machine }
}

/** Beat 2: the `joined` event. The owner ruled the page says when the account
 *  ssh logs in as is not the one that joined, or a block was kept (ADR-0029);
 *  the daemon's sentence says exactly that, so it is the words. */
export function joined(name: string, events: Event[], eventsError: Error | null, report: Readiness | null): Beat {
  const join = newest(events, name, ['joined'])
  if (join) {
    const reply = join.joined
    const wrong = reply !== null && reply !== undefined && reply.logs_in_as !== reply.user
    return { state: wrong ? 'stuck' : 'done', words: join.said }
  }
  if (check(report, 'reachable')?.state === 'present') {
    return { state: 'done', words: `${name} answers ssh, so it joined before · the daemon forgets its events when it restarts` }
  }
  if (eventsError) return { state: 'stuck', words: "the daemon's events could not be read, so a join cannot be seen", error: eventsError }
  return { state: 'waiting', words: `run the join command once in a terminal on ${name}` }
}

/** Beat 3: readiness answers `reachable`, which only a running `sshd` can. */
export function reachable(before: Beat, name: string, report: Readiness | null, events: Event[], ask: Asked, platform: Platform): Beat {
  if (before.state !== 'done') return { state: 'waiting', words: 'waits for the join' }
  const reach = check(report, 'reachable')
  if (reach?.state === 'present') {
    const sshd = check(report, 'sshd')
    return { state: 'done', words: `Yantra reached ${name} over ssh${sshd?.state === 'present' ? ` · ${sshd.detail}` : ''}` }
  }
  if (ask.pending) return { state: 'waiting', words: `asking ${name} over ssh…` }
  if (ask.error) return { state: 'stuck', words: `${name} was not asked`, error: ask.error }
  const hint = platform === 'macOS' ? ' · check that Remote Login is on' : ''
  if (reach) return { state: 'stuck', words: `ssh did not get into ${name} · ${reach.detail}${hint}` }
  const since = newest(events, name, ['joined'])?.at ?? 0
  const lost = events.find((one) => one.machine === name && one.kind === 'unreachable' && one.at >= since)
  if (lost) return { state: 'stuck', words: `${lost.said}${hint}` }
  return { state: 'waiting', words: `Yantra asks ${name} when it joins · Check asks now` }
}

function missing(report: Readiness | null): string {
  const absent = TOOLS.filter((one) => check(report, one)?.state === 'absent').map(word)
  const unknown = TOOLS.filter((one) => check(report, one)?.state !== 'absent' && check(report, one)?.state !== 'present').map(word)
  return [absent.length ? `missing ${absent.join(', ')}` : '', unknown.length ? `could not ask about ${unknown.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ')
}

/** Beat 4: `tmux`, `git` and `claude` present, after Install where they were
 *  not (ADR-0028). */
export function ready(before: Beat, name: string, report: Readiness | null, events: Event[], ask: Asked, install: Asked): Beat {
  if (before.state !== 'done') return { state: 'waiting', words: 'waits for ssh' }
  if (TOOLS.every((one) => check(report, one)?.state === 'present')) {
    return { state: 'done', words: `${name} is ready · tmux, git and claude are there` }
  }
  if (install.pending) return { state: 'waiting', words: `installing on ${name} · it can take minutes, and this ticks when it ends` }
  if (install.error) return { state: 'stuck', words: `the install on ${name} did not start`, error: install.error }
  if (ask.pending) return { state: 'waiting', words: `asking ${name} again…` }
  if (ask.error) return { state: 'stuck', words: `${name} was not asked`, error: ask.error }
  const last = newest(events, name, ['installed', 'install_stopped'])
  if (last?.kind === 'install_stopped') return { state: 'stuck', words: last.said, commands: last.commands }
  if (last?.kind === 'installed') return { state: 'waiting', words: `${last.said} · Check asks ${name} again` }
  return { state: 'waiting', words: `${missing(report)} · Install adds what is missing` }
}

/** What the page re-asks after: a join or an install it saw arrive. */
export const lastAsk = (events: Event[], name: string) =>
  newest(events, name, ['joined', 'installed', 'install_stopped'])?.at ?? 0

/** Where a new install's event will land: the newest one before it. */
export const lastInstall = (events: Event[], name: string) =>
  newest(events, name, ['installed', 'install_stopped'])?.at ?? 0
