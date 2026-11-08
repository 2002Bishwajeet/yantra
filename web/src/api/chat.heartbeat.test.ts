/**
 * The chat client's reopen and heartbeat rules (Y-668), against a fake socket
 * and fake timers: a phone that sleeps leaves a socket no close event reports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PING_EVERY, PONG_WITHIN, openChat, type ChatSocket } from './chat'
import type { ChatError } from './chat'
import type { ThreadEvent } from './thread'

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static all: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((message: { data: unknown }) => void) | null = null
  onclose: ((closed: { wasClean: boolean }) => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  say(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop() {
    this.readyState = 3
    this.onclose?.({ wasClean: false })
  }
  pinged() {
    return this.sent.filter((frame) => frame === '{"type":"ping"}').length
  }
}

let visibility: 'visible' | 'hidden'
const show = (state: 'visible' | 'hidden') => {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

const started = (cursor?: string): ThreadEvent => ({
  threadId: 't',
  ...(cursor ? { cursor } : {}),
  type: 'turn.started',
})

let socket: ChatSocket | undefined
function connect() {
  const events: ThreadEvent[] = []
  const errors: ChatError[] = []
  const dropped = vi.fn()
  const opened = vi.fn()
  socket = openChat((after) => `ws://x/chat?thread=t${after ? `&after=${after}` : ''}`, {
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
    onDropped: dropped,
    onOpen: opened,
  })
  vi.advanceTimersByTime(0)
  const first = FakeSocket.all[0]!
  first.open()
  return { events, errors, dropped, opened, first }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.all = []
  visibility = 'visible'
  vi.stubGlobal('WebSocket', FakeSocket)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})

afterEach(() => {
  socket?.close()
  socket = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the chat socket after a drop', () => {
  it('keeps reopening past five tries while the page is visible', () => {
    const { first, errors } = connect()
    let latest = first
    for (let n = 1; n <= 8; n++) {
      latest.drop()
      vi.advanceTimersByTime(8_000)
      expect(FakeSocket.all).toHaveLength(n + 1)
      latest = FakeSocket.all[n]!
    }
    expect(errors).toEqual([])
  })

  it('schedules no reopen while hidden, and reopens within 500 ms once shown', () => {
    const { first, dropped } = connect()
    show('hidden')
    first.drop()
    vi.advanceTimersByTime(120_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(dropped).toHaveBeenCalledTimes(1)

    show('visible')
    vi.advanceTimersByTime(500)
    expect(FakeSocket.all).toHaveLength(2)

    // The budget is back at its first pause.
    FakeSocket.all[1]!.open()
    FakeSocket.all[1]!.drop()
    vi.advanceTimersByTime(999)
    expect(FakeSocket.all).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.all).toHaveLength(3)
  })

  it('drops a reopen that was waiting when the page was hidden', () => {
    const { first } = connect()
    first.drop()
    show('hidden')
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('reopens at once when the network comes back', () => {
    connect()
    for (let n = 1; n <= 4; n++) {
      FakeSocket.all.at(-1)!.drop()
      vi.advanceTimersByTime(8_000)
    }
    FakeSocket.all.at(-1)!.drop()
    const before = FakeSocket.all.length
    window.dispatchEvent(new Event('online'))
    expect(FakeSocket.all).toHaveLength(before + 1)
  })

  it('pings an open socket when the page is shown again', () => {
    const { first } = connect()
    show('hidden')
    show('visible')
    expect(first.pinged()).toBe(1)
    vi.advanceTimersByTime(PONG_WITHIN)
    expect(FakeSocket.all).toHaveLength(2)
  })
})

describe('the chat socket heartbeat', () => {
  it('reopens after the last cursor when no pong comes', () => {
    const { first, dropped, errors } = connect()
    first.say(started('r1:812:0'))
    vi.advanceTimersByTime(PING_EVERY)
    expect(first.pinged()).toBe(1)
    vi.advanceTimersByTime(PONG_WITHIN - 1)
    expect(FakeSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(dropped).toHaveBeenCalledTimes(1)
    expect(first.onclose).toBeNull()
    expect(FakeSocket.all).toHaveLength(2)
    expect(FakeSocket.all[1]!.url).toBe('ws://x/chat?thread=t&after=r1:812:0')
    expect(errors).toEqual([])
  })

  it('takes a pong as proof, and a pong is no event and no error', () => {
    const { first, events, errors } = connect()
    vi.advanceTimersByTime(PING_EVERY)
    first.say({ type: 'pong' })
    vi.advanceTimersByTime(PONG_WITHIN * 2)
    expect(FakeSocket.all).toHaveLength(1)
    expect(events).toEqual([])
    expect(errors).toEqual([])
  })

  it('takes any frame as proof', () => {
    const { first, events } = connect()
    vi.advanceTimersByTime(PING_EVERY)
    first.say(started('r1:1:0'))
    vi.advanceTimersByTime(PONG_WITHIN * 2)
    expect(FakeSocket.all).toHaveLength(1)
    expect(events).toHaveLength(1)
  })

  it('removes its listeners and timers when it closes', () => {
    const { first } = connect()
    first.drop()
    socket!.close()
    socket = undefined
    vi.advanceTimersByTime(60_000)
    show('hidden')
    show('visible')
    window.dispatchEvent(new Event('online'))
    expect(FakeSocket.all).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
