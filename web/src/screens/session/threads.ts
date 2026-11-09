/*
 * The grouping and the status marks adapt T3 Code's thread list: a sidebar
 * that sorts threads by what is still open, and marks each with its PR:
 * https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/Sidebar.logic.ts
 * https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/ThreadStatusIndicators.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import type { Thread, ThreadPr } from '@/api'
import type { MarkState } from '@/m3/mark/Mark'

/** A PR that is still going is "Active"; a closed or merged one is done with. */
export function prMark(pr: ThreadPr): { state: MarkState; word: string } {
  switch (pr.state) {
    case 'none':
      return { state: 'idle', word: 'no PR' }
    case 'open':
      return { state: 'running', word: `PR #${pr.number} open` }
    case 'closed':
      return { state: 'failed', word: `PR #${pr.number} closed` }
    case 'merged':
      return { state: 'done', word: `PR #${pr.number} merged` }
    case 'unknown':
      return { state: 'unknown', word: 'PR unknown' }
  }
}

const finished = (one: Thread) => one.pr.state === 'closed' || one.pr.state === 'merged'

/** What a person reads for a thread: never its id, which is random hex. */
export const threadTitle = (one: Thread) => one.title ?? one.issue ?? 'Untitled thread'

/** "8s", "3m 04s" or "1h 02m". */
export function elapsed(since: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${two(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${two(Math.floor((seconds % 3600) / 60))}m`
}

const working = (one: Thread) => (one.state === 'working' ? 0 : 1)

export function groupThreads(threads: Thread[]) {
  return [
    {
      title: 'Active',
      items: threads.filter((one) => !finished(one)).sort((a, b) => working(a) - working(b)),
    },
    { title: 'Finished', items: threads.filter(finished) },
  ].filter((group) => group.items.length > 0)
}
