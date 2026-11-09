import { describe, expect, it } from 'vitest'
import type { Entry, Timeline } from './timeline'
import { formatWorked, workRows } from './workLog.logic'

const tool = (id: string, turn: number): Entry => ({
  kind: 'tool',
  id,
  turn,
  itemType: 'command_execution',
  status: 'completed',
  title: id,
  output: null,
})
const say = (id: string, who: 'you' | 'agent' | 'thinking', turn: number): Entry => ({ kind: 'message', id, who, text: id, turn })
const diff = (turn: number): Entry => ({ kind: 'diff', id: `diff:${turn}`, turn, unified: '', truncated: false, reverted: false })

const view = (entries: Entry[], worked: Timeline['worked'] = {}, turns = 1, turn: Timeline['turn'] = 'idle') => ({
  entries,
  worked,
  turns,
  turn,
})

describe('formatWorked', () => {
  it.each([
    [4000, '4s'],
    [3580, '4s'],
    [100, '1s'],
    [59_000, '59s'],
    [60_000, '1m 0s'],
    [125_000, '2m 5s'],
  ])('writes %i ms as %s', (ms, text) => {
    expect(formatWorked(ms)).toBe(text)
  })
})

describe('workRows', () => {
  const turn = [say('q', 'you', 0), say('t', 'thinking', 1), tool('a', 1), say('mid', 'agent', 1), tool('b', 1), say('end', 'agent', 1), diff(1)]

  it('folds the calls, thinking and intermediate replies of a turn into one row where the first was', () => {
    const rows = workRows(view(turn, { 1: { state: 'completed', durationMs: 4000 } }))
    expect(rows.map((one) => (one.kind === 'entry' ? one.entry.id : one.id))).toEqual(['q', 'work:1', 'end', 'diff:1'])
    const work = rows[1]
    expect(work).toMatchObject({ kind: 'work', calls: 2, state: 'done', label: 'Worked for 4s' })
    expect(work.kind === 'work' && work.items.map((one) => one.id)).toEqual(['t', 'a', 'mid', 'b'])
  })

  it('keeps a turn that only spoke as it is', () => {
    const rows = workRows(view([say('q', 'you', 0), say('end', 'agent', 1)]))
    expect(rows.every((one) => one.kind === 'entry')).toBe(true)
  })

  it('makes one row for each turn', () => {
    const rows = workRows(view([tool('a', 1), say('r1', 'agent', 1), tool('b', 2), say('r2', 'agent', 2)], {}, 2))
    expect(rows.filter((one) => one.kind === 'work').map((one) => one.kind === 'work' && one.turn)).toEqual([1, 2])
  })

  it('says Worked with no figure', () => {
    const [row] = workRows(view([tool('a', 1)], { 1: { state: 'completed' } }))
    expect(row).toMatchObject({ label: 'Worked' })
  })

  it('says how long a stopped turn ran, or that it stopped', () => {
    expect(workRows(view([tool('a', 1)], { 1: { state: 'cancelled', durationMs: 7000 } }))[0]).toMatchObject({
      label: 'You stopped after 7s',
    })
    expect(workRows(view([tool('a', 1)], { 1: { state: 'cancelled' } }))[0]).toMatchObject({
      label: 'You stopped this response',
    })
  })

  it('marks a failed turn', () => {
    expect(workRows(view([tool('a', 1)], { 1: { state: 'failed', durationMs: 2000 } }))[0]).toMatchObject({
      state: 'failed',
      label: 'Worked for 2s',
    })
  })

  it('says Working for the turn that runs, and Worked for an earlier one', () => {
    const entries = [tool('a', 1), say('r1', 'agent', 1), tool('b', 2)]
    const rows = workRows(view(entries, { 1: { state: 'completed', durationMs: 1000 } }, 2, 'running'))
    expect(rows.filter((one) => one.kind === 'work')).toMatchObject([
      { label: 'Worked for 1s', state: 'done' },
      { label: 'Working', state: 'running' },
    ])
  })
})
