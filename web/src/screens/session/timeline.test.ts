import { describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@/api/thread'
import { chatEvents } from '@/contract.gen'
import { empty, reduce, type Action, type Timeline } from './timeline'

const event = (e: ThreadEvent): Action => ({ type: 'event', event: e })
const fold = (actions: Action[], from: Timeline = empty) => actions.reduce(reduce, from)

describe('the timeline', () => {
  it('folds what the daemon really sends into one tool, one message and the usage', () => {
    // The last event is a second, failed ending; the fold keeps the first's turn.
    const timeline = fold(chatEvents.slice(0, -1).map(event))

    expect(timeline.thread).toBe('1a2b3c4d')
    expect(timeline.entries).toEqual([
      { kind: 'message', id: 'msg_1:1', who: 'claude', text: 'Running the tests.' },
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
      ['claude', 'Hello there!'],
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

  it('starts over on a reset and keeps the thread', () => {
    const timeline = fold(chatEvents.map(event))
    expect(reduce(timeline, { type: 'reset' })).toEqual({ ...empty, thread: '1a2b3c4d' })
  })

  it('draws nothing for a plan or a title', () => {
    const plan = event({ threadId: 't', type: 'turn.plan.updated', payload: { plan: [] } })
    const named = event({ threadId: 't', type: 'thread.metadata.updated', payload: { name: 'x' } })
    expect(fold([plan, named])).toEqual(empty)
  })
})
