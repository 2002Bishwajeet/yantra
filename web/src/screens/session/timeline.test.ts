import { describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@/api/thread'
import { chatCheckpoints, chatEvents } from '@/contract.gen'
import { empty, reduce, type Action, type Timeline } from './timeline'

const event = (e: ThreadEvent): Action => ({ type: 'event', event: e })
const fold = (actions: Action[], from: Timeline = empty) => actions.reduce(reduce, from)

describe('the timeline', () => {
  it('folds what the daemon really sends into one tool, one message and the usage', () => {
    // The last event is a second, failed ending; the fold keeps the first's turn.
    const timeline = fold(chatEvents.slice(0, -1).map(event))

    expect(timeline.thread).toBe('1a2b3c4d')
    expect(timeline.harness).toBe('opencode')
    expect(timeline.entries).toEqual([
      { kind: 'message', id: 'msg_1:1', who: 'agent', text: 'Running the tests.' },
      {
        kind: 'tool',
        id: 'toolu_1',
        itemType: 'command_execution',
        status: 'completed',
        title: 'cargo test',
        output: 'test result: ok',
      },
    ])
    expect(timeline.requests).toEqual([])
    expect(timeline.usage).toEqual({ used: 29_149, max: 200_000 })
    expect(timeline.turn).toBe('idle')
    expect(timeline.ended).toEqual({ state: 'completed', stopReason: 'end_turn' })
  })

  it('joins deltas by item id, and by voice when there is none', () => {
    const delta = (streamKind: 'assistant_text' | 'user_text', text: string, itemId?: string) =>
      event({ threadId: 't', type: 'content.delta', payload: { streamKind, delta: text, itemId } })
    const timeline = fold([
      delta('user_text', 'hi', 'user:1'),
      delta('assistant_text', 'Hel', 'm:1'),
      delta('assistant_text', 'lo', 'm:1'),
      delta('assistant_text', ' there'),
      delta('assistant_text', '!'),
      delta('user_text', 'again'),
    ])
    expect(timeline.entries.map((one) => (one.kind === 'message' ? [one.who, one.text] : null))).toEqual([
      ['you', 'hi'],
      ['agent', 'Hello there!'],
      ['you', 'again'],
    ])
  })

  it('keeps an open request until it is resolved or the turn ends', () => {
    const opened = chatEvents.find((one) => one.type === 'request.opened')!
    const asking = fold([{ type: 'sent' }, event(opened)])
    expect(asking.turn).toBe('sent')
    expect(asking.requests.map((one) => one.requestId)).toEqual(['r1'])

    const resolved = chatEvents.find((one) => one.type === 'request.resolved')!
    expect(fold([event(resolved)], asking).requests).toEqual([])

    const failed = chatEvents[chatEvents.length - 1]!
    const ended = fold([event(failed)], asking)
    expect(ended.requests).toEqual([])
    expect(ended.turn).toBe('idle')
    expect(ended.ended).toEqual({ state: 'failed', message: 'Not logged in · Please run /login' })
  })

  it('walks a turn from sent through stopping to idle, and a refusal ends it', () => {
    const started = fold([{ type: 'sent' }, event({ threadId: 't', type: 'turn.started' })])
    expect(started.turn).toBe('running')
    const stopping = reduce(started, { type: 'stopping' })
    expect(stopping.turn).toBe('stopping')
    // A late turn.started does not take the stop back.
    expect(fold([event({ threadId: 't', type: 'turn.started' })], stopping).turn).toBe('stopping')
    expect(reduce(empty, { type: 'stopping' })).toBe(empty)
    expect(reduce(started, { type: 'refused' }).turn).toBe('idle')
  })

  it('starts over on a reset and keeps the thread and its harness', () => {
    const timeline = fold(chatEvents.map(event))
    expect(reduce(timeline, { type: 'reset' })).toEqual({ ...empty, thread: '1a2b3c4d', harness: 'opencode' })
  })

  it('keeps the harness the daemon names, Claude included', () => {
    const started = (harness: 'claude' | 'grok') =>
      event({ threadId: 't', type: 'thread.started', payload: { thread: 't', harness } })
    expect(fold([started('claude')]).harness).toBe('claude')
    expect(fold([started('grok')]).harness).toBe('grok')
    expect(empty.harness).toBeNull()
  })

  it("appends a card for each turn's diff, and a revert marks the turns above it", () => {
    const [diff, reverted] = chatCheckpoints
    const turn = (n: number) => event({ threadId: 't', type: 'turn.diff.updated', payload: { turn: n, unifiedDiff: `+${n}\n`, truncated: n === 2 } })
    const two = fold([event(diff!), turn(2)])
    expect(two.entries).toEqual([
      {
        kind: 'diff',
        id: 'diff:0',
        turn: 1,
        unified: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n',
        truncated: false,
        reverted: false,
      },
      { kind: 'diff', id: 'diff:1', turn: 2, unified: '+2\n', truncated: true, reverted: false },
    ])

    const back = fold([event({ threadId: 't', type: 'thread.reverted', payload: { turn: 1 } })], two)
    expect(back.entries.map((one) => one.kind === 'diff' && one.reverted)).toEqual([false, true])
    // The next turn takes number 2 again, and gets a card of its own.
    const again = fold([turn(2), event(reverted!)], back)
    expect(again.entries.map((one) => (one.kind === 'diff' ? [one.id, one.turn, one.reverted] : null))).toEqual([
      ['diff:0', 1, true],
      ['diff:1', 2, true],
      ['diff:2', 2, true],
    ])
    expect(again.turn).toBe('idle')
  })

  it('draws nothing for a plan or a title', () => {
    const plan = event({ threadId: 't', type: 'turn.plan.updated', payload: { plan: [] } })
    const named = event({ threadId: 't', type: 'thread.metadata.updated', payload: { name: 'x' } })
    expect(fold([plan, named])).toEqual(empty)
  })
})
