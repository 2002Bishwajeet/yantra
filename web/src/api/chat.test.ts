/**
 * The chat client against a real WebSocket server. Every error path ends in a
 * typed `ChatError`, and every frame asserted here crossed a socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { chatEvents, chatFailure, chatFrames, chatNotLoggedIn } from '@/contract.gen'
import { browser, daemon } from '@/screens/session/harness'
import { ChatError, chatAddress, frameOf, openChat } from './chat'
import type { ThreadEvent } from './thread'

const settled = <T,>(check: () => T) => waitFor(check, { timeout: 5_000 })

let server: Awaited<ReturnType<typeof daemon>>

function connect(url = chatAddress('yantra-web')) {
  const events: ThreadEvent[] = []
  const errors: ChatError[] = []
  const opened = vi.fn()
  const socket = openChat(url, {
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
    onOpen: opened,
  })
  return { socket, events, errors, opened }
}

beforeEach(async () => {
  browser()
  server = await daemon()
  vi.stubGlobal('location', new URL(`http://127.0.0.1:${server.port}/`))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await server.stop()
})

describe('the chat socket', () => {
  it('names the workspace, and the thread when there is one', () => {
    expect(chatAddress('a b')).toBe(`ws://127.0.0.1:${server.port}/api/workspaces/a%20b/chat`)
    expect(chatAddress('w', '1a2b3c4d')).toBe(
      `ws://127.0.0.1:${server.port}/api/workspaces/w/chat?thread=1a2b3c4d`,
    )
  })

  it('sends a turn, an answer and a stop as the frames the daemon reads', async () => {
    const { socket, opened } = connect()
    expect(socket.send('too early')).toBe(false)
    await settled(() => expect(opened).toHaveBeenCalled())

    expect(socket.send('run the tests')).toBe(true)
    expect(socket.answer('r1', 'acceptAlways')).toBe(true)
    expect(socket.stop()).toBe(true)
    await settled(() => expect(server.heard).toHaveLength(3))
    expect(server.heard.map((frame) => ('text' in frame ? JSON.parse(frame.text) : null))).toEqual([
      { type: 'turn', text: 'run the tests' },
      { type: 'answer', requestId: 'r1', decision: 'acceptAlways' },
      { type: 'cancel' },
    ])
    socket.close()
  })

  it('hands every event on, in order', async () => {
    const { events, opened } = connect()
    await settled(() => expect(opened).toHaveBeenCalled())
    for (const event of chatEvents.slice(0, -1)) server.say(JSON.stringify(event))
    await settled(() => expect(events).toHaveLength(chatEvents.length - 1))
    expect(events.map((event) => event.type)).toEqual(chatEvents.slice(0, -1).map((event) => event.type))
  })

  it('reports a failed turn as turnFailed in its own words, after the event', async () => {
    const { events, errors, opened } = connect()
    await settled(() => expect(opened).toHaveBeenCalled())
    server.say(JSON.stringify(chatEvents[chatEvents.length - 1]))
    await settled(() => expect(errors).toHaveLength(1))
    expect(events).toHaveLength(1)
    expect(errors[0]?.kind).toBe('turnFailed')
    expect(errors[0]?.said).toBe('Not logged in · Please run /login')
    expect(errors[0]?.retryable).toBe(false)
    expect(errors[0]?.describe()).toBe('The agent could not finish the turn.')
  })

  it.each([
    ['busy', false],
    ['badFrame', false],
    ['unreachable', true],
  ] as const)('types a %s frame from the daemon', async (kind, retryable) => {
    const { errors, opened } = connect()
    await settled(() => expect(opened).toHaveBeenCalled())
    server.say(JSON.stringify({ ...chatFailure, kind, said: `the daemon said ${kind}` }))
    await settled(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toBeInstanceOf(ChatError)
    expect(errors[0]?.kind).toBe(kind)
    expect(errors[0]?.said).toBe(`the daemon said ${kind}`)
    expect(errors[0]?.retryable).toBe(retryable)
  })

  it('types a missing login with whose it is, where, and the command, and says it once', async () => {
    const { errors, opened } = connect(chatAddress('yantra-web', '1a2b3c4d'))
    await settled(() => expect(opened).toHaveBeenCalled())
    server.say(JSON.stringify(chatNotLoggedIn))
    server.hangUp()
    await settled(() => expect(errors).toHaveLength(1))
    await new Promise((done) => setTimeout(done, 100))
    expect(errors.map((error) => error.kind)).toEqual(['notLoggedIn'])
    expect(errors[0]?.login).toEqual({ harness: 'opencode', machine: 'cachyos-g14', command: 'opencode auth login' })
    expect(errors[0]?.said).toBe('the agent refused: Authentication required (-32000)')
    expect(errors[0]?.describe()).toBe('Run this on cachyos-g14, then retry.')
    expect(errors[0]?.retryable).toBe(false)
  })

  it('sends the harness on a turn only when it is given', async () => {
    const { socket, opened } = connect()
    await settled(() => expect(opened).toHaveBeenCalled())
    socket.send('run the tests', 'opencode')
    socket.send('and the docs')
    await settled(() => expect(server.heard).toHaveLength(2))
    expect(server.heard.map((frame) => ('text' in frame ? JSON.parse(frame.text) : frame))).toEqual(
      chatFrames.slice(0, 2),
    )
  })

  it('says an unknown thread once, not again as a close', async () => {
    const { errors, opened } = connect(chatAddress('yantra-web', 'ffffffff'))
    await settled(() => expect(opened).toHaveBeenCalled())
    expect(server.asked).toEqual(['/api/workspaces/yantra-web/chat?thread=ffffffff'])
    server.say(JSON.stringify({ type: 'error', kind: 'unknownThread', said: 'web has no chat thread ffffffff' }))
    server.hangUp()
    await settled(() => expect(errors).toHaveLength(1))
    await new Promise((done) => setTimeout(done, 100))
    expect(errors.map((error) => error.kind)).toEqual(['unknownThread'])
  })

  it('reports a frame it cannot read as badFrame with a sentence of its own', async () => {
    const { errors, opened } = connect()
    await settled(() => expect(opened).toHaveBeenCalled())
    server.say('not json')
    server.say(JSON.stringify({ type: 'error', kind: 'mystery', said: 'x' }))
    server.print('bytes')
    await settled(() => expect(errors).toHaveLength(3))
    expect(errors.map((error) => error.kind)).toEqual(['badFrame', 'badFrame', 'badFrame'])
    expect(errors[0]?.describe()).toBe('The daemon sent a frame this dashboard cannot read.')
    expect(errors[0]?.said).toBe('not json')
  })

  it('reports a socket that closed after it opened as closed, and retryable', async () => {
    const { errors, opened } = connect()
    await settled(() => expect(opened).toHaveBeenCalled())
    server.hangUp()
    await settled(() => expect(errors).toHaveLength(1))
    expect(errors[0]?.kind).toBe('closed')
    expect(errors[0]?.retryable).toBe(true)
  })

  it('reports a socket that never opened as refused', async () => {
    const port = server.port
    await server.stop()
    const { errors } = connect(`ws://127.0.0.1:${port}/api/workspaces/w/chat`)
    await settled(() => expect(errors).toHaveLength(1))
    expect(errors[0]?.kind).toBe('refused')
    expect(errors[0]?.retryable).toBe(false)
    server = await daemon()
  })

  it('reports nothing once it is closed on purpose', async () => {
    const { socket, errors, opened } = connect()
    await settled(() => expect(opened).toHaveBeenCalled())
    socket.close()
    await settled(() => expect(server.ended()).toBe(true))
    expect(errors).toEqual([])
    expect(socket.send('after')).toBe(false)
  })
})

describe('a daemon frame', () => {
  it('is an event, a failure, or nothing', () => {
    expect(frameOf(JSON.stringify(chatEvents[0]))).toEqual(chatEvents[0])
    expect(frameOf(JSON.stringify(chatFailure))).toEqual(chatFailure)
    expect(frameOf('[]')).toBeNull()
    expect(frameOf('{"type":"turn.started"}')).toBeNull()
    expect(frameOf('{"type":"error","kind":"busy"}')).toBeNull()
  })

  it('is a missing login only with a known harness, a machine and a command', () => {
    expect(frameOf(JSON.stringify(chatNotLoggedIn))).toEqual(chatNotLoggedIn)
    for (const broken of [
      { harness: 'aider' },
      { harness: undefined },
      { machine: 7 },
      { command: '' },
      { command: undefined },
    ]) {
      expect(frameOf(JSON.stringify({ ...chatNotLoggedIn, ...broken }))).toBeNull()
    }
  })
})
