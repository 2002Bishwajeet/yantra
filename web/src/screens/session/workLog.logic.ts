/*
 * The grouping adapts T3 Code's MessagesTimeline.logic work groups and its formatWorkingTimer:
 * https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/MessagesTimeline.logic.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import type { Entry, Message, Timeline, Tool } from './timeline'

export type Folded = Tool | (Message & { who: 'agent' | 'thinking' })

export type Row =
  | { kind: 'entry'; entry: Entry }
  | {
      kind: 'work'
      id: string
      turn: number
      items: Folded[]
      label: string
      state: 'running' | 'done' | 'failed'
      calls: number
    }

/** `Ns` under a minute, then `Xm Ys`. */
export function formatWorked(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function labelOf(ended: Timeline['worked'][number] | undefined, running: boolean): string {
  if (!ended) return running ? 'Working' : 'Worked'
  const time = ended.durationMs === undefined ? null : formatWorked(ended.durationMs)
  if (ended.state === 'cancelled') return time ? `You stopped after ${time}` : 'You stopped this response'
  return time ? `Worked for ${time}` : 'Worked'
}

/** Folds each turn's calls, thinking and intermediate replies into one row, where the first of them was. */
export function workRows(timeline: Pick<Timeline, 'entries' | 'worked' | 'turns' | 'turn'>): Row[] {
  const { entries, worked, turns } = timeline
  const lastAnswer = new Map<number, number>()
  entries.forEach((one, at) => {
    if (one.kind === 'message' && one.who === 'agent') lastAnswer.set(one.turn, at)
  })
  const rows: Row[] = []
  const groups = new Map<number, Extract<Row, { kind: 'work' }>>()
  entries.forEach((entry, at) => {
    const folds =
      entry.kind === 'tool' ||
      (entry.kind === 'message' &&
        (entry.who === 'thinking' || (entry.who === 'agent' && lastAnswer.get(entry.turn) !== at)))
    if (!folds) {
      rows.push({ kind: 'entry', entry })
      return
    }
    let group = groups.get(entry.turn)
    if (!group) {
      const ended = worked[entry.turn]
      const running = !ended && timeline.turn !== 'idle' && entry.turn === turns
      group = {
        kind: 'work',
        id: `work:${entry.turn}`,
        turn: entry.turn,
        items: [],
        label: labelOf(ended, running),
        state: running ? 'running' : ended?.state === 'failed' ? 'failed' : 'done',
        calls: 0,
      }
      groups.set(entry.turn, group)
      rows.push(group)
    }
    group.items.push(entry as Folded)
    if (entry.kind === 'tool') group.calls += 1
  })
  return rows
}
