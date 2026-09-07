import type { Attention, Event } from '@/api'

/** One row of the notifications list: a daemon event (ADR-0025) or a GitHub
 *  item from `/api/attention`, which the browser merges (api.ts, `Event`). */
export type Entry = {
  id: string
  /** Unix seconds. */
  at: number
  tile: { kind: 'workspace'; name: string } | { kind: 'github' } | { kind: 'relay' } | { kind: 'machine'; name: string }
  headline: string
  supporting: string
  /** A trust prompt: the row offers Answer, into this workspace's chat. */
  answer?: string
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

function ofEvent(event: Event, index: number): Entry {
  const who = event.workspace ?? event.machine ?? 'the daemon'
  const tile: Entry['tile'] = event.workspace
    ? { kind: 'workspace', name: event.workspace }
    : event.kind === 'relay-test'
      ? { kind: 'relay' }
      : { kind: 'machine', name: event.machine ?? '?' }
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
    id: `event-${event.at}-${index}`,
    at: event.at,
    tile,
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
