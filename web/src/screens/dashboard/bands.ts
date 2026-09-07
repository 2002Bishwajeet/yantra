import type { Event, Machine, MachineSessions, Workspace } from '@/api'
import type { Reading } from '@/api/hooks'
import type { MarkState } from '@/m3/mark/Mark'
import { at } from '@/lib/time'

export type Down = { name: string; since: string | null }

/** The status strip's figures: how many the tailnet sees, and who it does not. */
export function online(machines: Machine[], now: number): { up: number; down: Down[] } {
  const down = machines.flatMap((one) =>
    one.online
      ? []
      : [{ name: one.name, since: one.last_seen ? (at(one.last_seen, now)?.text ?? null) : null }],
  )
  return { up: machines.length - down.length, down }
}

// One refresh period. A read this far behind the rest is not the same reading.
const BEHIND = 30

export type Read = { name: string; reading: Reading<unknown> }

/** D3 §4.3: the age is the **oldest** read, never an average, and a read more
 *  than one sweep behind the rest is named beside it. Null before any read. */
export function stamp(reads: Read[]): { age: number; late: { name: string; age: number }[] } | null {
  const aged = reads.flatMap((read) =>
    read.reading.looked === 'ok' || read.reading.looked === 'failed'
      ? [{ name: read.name, age: read.reading.age_seconds }]
      : [],
  )
  if (aged.length === 0) return null
  const youngest = Math.min(...aged.map((one) => one.age))
  const late = aged.filter((one) => one.age - youngest > BEHIND)
  const rest = aged.filter((one) => one.age - youngest <= BEHIND)
  return { age: Math.max(...rest.map((one) => one.age)), late }
}

/** The tmux session behind a workspace, for its elapsed time. */
export function startedAt(sessions: Reading<MachineSessions[]>, workspace: Workspace): number | null {
  if (sessions.looked !== 'ok') return null
  const machine = sessions.data.find((one) => one.machine === workspace.machine)
  if (!machine || machine.reached !== 'yes') return null
  return machine.sessions.find((one) => one.name === workspace.name)?.created_at ?? null
}

/** The "asked 4m ago · Claude wants cargo test" behind a trust row, which no
 *  status carries (inventory §C) and the event ring buffer does. */
export function askedAt(events: Event[], workspace: string): Event | null {
  return events.find((one) => one.kind === 'awaiting_trust' && one.workspace === workspace) ?? null
}

/** The Compact board's Recent card: what happened, in the board's words. */
const happened: Record<Event['kind'], { mark: MarkState; words: string }> = {
  awaiting_trust: { mark: 'needs', words: 'asked for trust' },
  running: { mark: 'running', words: 'started' },
  no_agent: { mark: 'running', words: 'opened as a shell' },
  finished: { mark: 'done', words: 'finished' },
  stopped: { mark: 'idle', words: 'stopped' },
  no_session: { mark: 'idle', words: 'no session' },
  crashed: { mark: 'failed', words: 'crashed' },
  killed: { mark: 'failed', words: 'killed' },
  unclear: { mark: 'unknown', words: 'unclear' },
  unreachable: { mark: 'unknown', words: 'unreachable' },
  'relay-test': { mark: 'done', words: 'relay test' },
}

export type Recent = { workspace: string; machine: string; mark: MarkState; words: string; at: number }

/** The last five session events, newest first; a relay test is not one. */
export function recent(events: Event[], limit = 5): Recent[] {
  return events
    .filter((one): one is Event & { workspace: string } => one.workspace !== null)
    .toSorted((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((one) => ({
      workspace: one.workspace,
      machine: one.machine ?? '',
      at: one.at,
      ...happened[one.kind],
    }))
}
