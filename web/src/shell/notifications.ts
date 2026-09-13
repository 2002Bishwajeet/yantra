import type { Attention, Event } from '@/api'
import type { MarkState } from '@/m3/mark/Mark'

/** One row of the notifications list: a daemon event (ADR-0025) or a GitHub
 *  item from `/api/attention`, which the browser merges (api.ts, `Event`). */
export type Entry = {
  id: string
  /** Unix seconds. */
  at: number
  tile: { kind: 'workspace'; name: string } | { kind: 'github' } | { kind: 'relay' } | { kind: 'machine'; name: string }
  headline: string
  supporting: string
  mark?: MarkState
  /** `supporting` must wrap rather than clip: it carries a warning a person
   *  cannot act on if it is cut off (S7). */
  wrap?: boolean
  /** A trust prompt: the row offers Answer, into this workspace's chat. */
  answer?: string
  /** A join or install event: the row offers Open, into the machine page. */
  open?: string
  /** An install left these for a person to run, verbatim, via `Copyable`. */
  commands?: string[]
  /** A GitHub item opens on GitHub. */
  href?: string
}

/** `notificationsQuery` types the body as a bare list while api.ts says
 *  `Looked<Event[]>`; the shell takes either until the API layer settles it. */
export function asEvents(data: unknown): Event[] {
  if (Array.isArray(data)) return data as Event[]
  if (data && typeof data === 'object' && 'looked' in data && data.looked === 'ok') {
    return (data as unknown as { data: Event[] }).data
  }
  return []
}

// `events.rs::joined`'s only sentence that names no problem. The other three
// (kept, differs, unreadable) all read "{machine} joined as {user}, …" —
// distinct enough that matching this one line is the whole of the check.
const NORMAL_JOIN = / joined, and Yantra logs in there as (.+)$/

function ofEvent(event: Event, index: number): Entry {
  const who = event.workspace ?? event.machine ?? 'the daemon'
  const tile: Entry['tile'] = event.workspace
    ? { kind: 'workspace', name: event.workspace }
    : event.kind === 'relay-test'
      ? { kind: 'relay' }
      : { kind: 'machine', name: event.machine ?? '?' }
  const base = { id: `event-${event.at}-${index}`, at: event.at, tile }

  if (event.kind === 'joined' && event.machine) {
    const normal = NORMAL_JOIN.exec(event.said)
    return normal
      ? { ...base, headline: `${event.machine} joined`, supporting: `as ${normal[1]}`, mark: 'done', open: event.machine }
      : {
          ...base,
          headline: `${event.machine} joined, as another account`,
          supporting: event.said,
          mark: 'needs',
          open: event.machine,
          wrap: true,
        }
  }

  if (event.kind === 'installed' && event.machine) {
    return {
      ...base,
      headline: `${event.machine} is ready`,
      supporting: 'tmux, git and claude are installed',
      mark: 'done',
      open: event.machine,
    }
  }

  if (event.kind === 'install_stopped' && event.machine) {
    const { commands } = event
    return commands.length
      ? {
          ...base,
          headline: `${event.machine} needs your password`,
          supporting:
            commands.length === 1 ? 'One command is left for you to run' : `${commands.length} commands are left for you to run`,
          mark: 'needs',
          open: event.machine,
          commands,
        }
      : {
          ...base,
          headline: `${event.machine}'s install did not finish`,
          supporting: event.said,
          mark: 'needs',
          open: event.machine,
          wrap: true,
        }
  }

  const headline =
    event.kind === 'awaiting_trust'
      ? `${who} is waiting for trust`
      : event.kind === 'unreachable'
        ? `${who} became unreachable`
        : event.kind === 'relay-test'
          ? 'Test message arrived at the relay'
          : event.kind === 'crashed' || event.kind === 'killed'
            ? `${who} ${event.kind}`
            : `${who} ${event.kind.replace('_', ' ')}`
  const supporting = event.machine && event.workspace ? `${event.said} · ${event.machine}` : event.said
  return {
    ...base,
    headline,
    supporting,
    answer: event.kind === 'awaiting_trust' && event.workspace ? event.workspace : undefined,
  }
}

export function merge(events: Event[], attention: Attention | null): Entry[] {
  const github = attention
    ? [
        ...attention.reviews.map(
          (item): Entry => ({
            id: `review-${item.repo}-${item.number}`,
            at: Date.parse(item.updated_at) / 1000,
            tile: { kind: 'github' },
            headline: `Review requested on ${item.repo.split('/')[1]}#${item.number}`,
            supporting: item.title,
            href: item.url,
          }),
        ),
        ...attention.issues.map(
          (item): Entry => ({
            id: `issue-${item.repo}-${item.number}`,
            at: Date.parse(item.updated_at) / 1000,
            tile: { kind: 'github' },
            headline: `Issue assigned: ${item.repo.split('/')[1]}#${item.number}`,
            supporting: item.title,
            href: item.url,
          }),
        ),
      ]
    : []
  return [...events.map(ofEvent), ...github].toSorted((a, b) => b.at - a.at)
}

export const unseen = (entries: Entry[], seenAt: number | null) =>
  entries.filter((one) => seenAt === null || one.at > seenAt)

/** Today is the reader's calendar day, not the last 24 hours. */
export function grouped(entries: Entry[], now: number) {
  const day = new Date(now).toDateString()
  const today = entries.filter((one) => new Date(one.at * 1000).toDateString() === day)
  return { today, earlier: entries.filter((one) => !today.includes(one)) }
}
