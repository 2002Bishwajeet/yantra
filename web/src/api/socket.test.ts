/**
 * The socket wrapper against a real `ws` server, as `terminal.test.tsx` does
 * for the whole terminal: every frame below crossed a socket. What this file
 * adds is the half a chat composer will use without xterm.js — `type`, the
 * size frame, and a refusal arriving as an `ApiError`.
 */
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { type WebSocket as Client, WebSocket as Ws, WebSocketServer } from 'ws'
import { ApiError } from './errors'
import {
  ATTEMPTS,
  attachTerminal,
  type Attached,
  type Link,
  PAUSE,
  terminalAddress,
} from './socket'

type Frame = { text: string } | { bytes: number[] }

async function daemon() {
  let upgrading = true
  // The authoriser's answer is a status on the upgrade: no socket, no frame.
  const server = new WebSocketServer({
    port: 0,
    verifyClient: (_info: unknown, done: (ok: boolean, code?: number, why?: string) => void) =>
      done(upgrading, 403, 'node pi is on this tailnet but is not yours'),
  })
  await once(server, 'listening')
  const heard: Frame[] = []
  let live: Client | undefined
  let connections = 0
  let refusing = false

  server.on('connection', (socket) => {
    live = socket
    connections += 1
    if (refusing) {
      socket.close()
      return
    }
    socket.on('message', (data: Buffer, binary: boolean) => {
      heard.push(binary ? { bytes: [...data] } : { text: data.toString() })
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    heard,
    connections: () => connections,
    print: (bytes: string) => live?.send(Buffer.from(bytes), { binary: true }),
    say: (text: string) => live?.send(text, { binary: false }),
    hangUp: () => live?.close(),
    keepHangingUp: () => {
      refusing = true
    },
    refuseUpgrades: () => {
      upgrading = false
    },
    stop: () =>
      new Promise((done) => {
        for (const socket of server.clients) socket.terminate()
        server.close(() => done(null))
      }),
  }
}

const settled = <T,>(check: () => T) => waitFor(check, { timeout: 10_000 })

let daemonised: Awaited<ReturnType<typeof daemon>>
let attached: Attached | undefined

beforeEach(async () => {
  vi.stubGlobal('WebSocket', Ws)
  daemonised = await daemon()
  vi.stubGlobal('location', new URL(`http://127.0.0.1:${daemonised.port}/`))
})

afterEach(async () => {
  attached?.close()
  attached = undefined
  vi.unstubAllGlobals()
  await daemonised.stop()
})

/** A composer's socket: no xterm, a fixed window. */
function attach() {
  const ended: (ApiError | null)[] = []
  const links: Link[] = []
  const printed: number[][] = []
  attached = attachTerminal(
    terminalAddress({ machine: 'pi', workspace: 'yantra' }),
    {
      size: () => ({ rows: 24, cols: 80 }),
      onBytes: (bytes) => printed.push([...bytes]),
      onEnd: (refused) => ended.push(refused),
      onLink: (link) => links.push(link),
    },
  )
  return { ended, links, printed, link: attached }
}

describe('the socket wrapper', () => {
  it('addresses both targets as the daemon spells them', () => {
    expect(terminalAddress({ machine: 'pi', workspace: 'a b' })).toBe(
      `ws://127.0.0.1:${daemonised.port}/api/workspaces/a%20b/terminal`,
    )
    expect(terminalAddress({ machine: 'pi', session: 'scratch' })).toBe(
      `ws://127.0.0.1:${daemonised.port}/api/machines/pi/sessions/scratch/terminal`,
    )
  })

  it('sends the size frame first, from the size it was given', async () => {
    const { links } = attach()

    await settled(() => expect(daemonised.heard.length).toBe(1))
    expect(JSON.parse((daemonised.heard[0] as { text: string }).text)).toEqual({
      rows: 24,
      cols: 80,
      term: 'xterm-256color',
    })
    expect(links).toEqual([{ up: true, attempt: 0 }])
  })

  it('types as bytes, and hands what is printed back as bytes', async () => {
    const { printed, link } = attach()
    await settled(() => expect(daemonised.heard.length).toBe(1))

    link.type('y\r')
    await settled(() => expect(daemonised.heard.length).toBe(2))
    expect(daemonised.heard[1]).toEqual({ bytes: [0x79, 0x0d] })

    daemonised.print('ok')
    await settled(() => expect(printed).toEqual([[0x6f, 0x6b]]))
  })

  /** A text frame is the daemon's reason, and it arrives typed: a `socket`
   *  error carrying the sentence verbatim, and nothing is reopened. */
  it('surfaces the daemon’s text frame as a socket error and stops', async () => {
    const { ended } = attach()
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.say("tmux: can't find session: =yantra")
    await settled(() => expect(ended.length).toBe(1))

    const error = ended[0]
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      kind: 'socket',
      said: "tmux: can't find session: =yantra",
      retryable: false,
    })
    expect(error?.describe()).toBe('The terminal could not be opened.')

    daemonised.hangUp()
    await new Promise((done) => setTimeout(done, PAUSE * 3))
    expect(daemonised.connections()).toBe(1)
  })

  /** The authoriser's 403 or 503 on the upgrade reaches a browser as a close
   *  with no text frame. A socket that never opened is not an outage. */
  it('ends a socket that never opened as refused, and reopens nothing', async () => {
    daemonised.refuseUpgrades()
    const { ended, links } = attach()

    await settled(() => expect(ended.length).toBe(1))
    expect(ended[0]).toBeInstanceOf(ApiError)
    expect(ended[0]).toMatchObject({ kind: 'refused', retryable: false })
    expect(links).toEqual([])
    await new Promise((done) => setTimeout(done, PAUSE * 3))
    expect(daemonised.connections()).toBe(0)
  })

  it('ends a socket whose address cannot be opened as a socket error', async () => {
    const ended: (ApiError | null)[] = []
    attachTerminal('not a url', {
      size: () => ({ rows: 24, cols: 80 }),
      onBytes: () => {},
      onEnd: (refused) => ended.push(refused),
      onLink: () => {},
    })
    await settled(() => expect(ended).toHaveLength(1))
    expect(ended[0]).toMatchObject({ kind: 'socket' })
  })

  /** StrictMode mounts, unmounts and mounts again, and a socket closed while
   *  CONNECTING is a console error nobody can act on. `ws` aborts the upgrade
   *  request the browser has already sent, so the count that proves this is
   *  the constructor's and not the daemon's. */
  it('opens nothing for an attach that is closed in the same tick', async () => {
    const opened = vi.fn()
    vi.stubGlobal(
      'WebSocket',
      class extends Ws {
        constructor(url: string) {
          super(url)
          opened()
        }
      },
    )
    attach().link.close()
    attached = undefined

    await new Promise((done) => setTimeout(done, PAUSE))
    expect(opened).not.toHaveBeenCalled()
    expect(daemonised.connections()).toBe(0)
  })

  it('reopens a socket that dropped and says its size again', async () => {
    const { links } = attach()
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.hangUp()

    await settled(() => expect(daemonised.connections()).toBe(2))
    await settled(() => expect(daemonised.heard.length).toBe(2))
    expect(links).toEqual([
      { up: true, attempt: 0 },
      { up: false, attempt: 1 },
      { up: true, attempt: 1 },
    ])
  })

  it('gives up after the budget with null, which is not a refusal', async () => {
    const { ended } = attach()
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.keepHangingUp()
    daemonised.hangUp()

    await waitFor(() => expect(ended).toEqual([null]), {
      timeout: PAUSE * (ATTEMPTS + 4),
    })
    expect(daemonised.connections()).toBe(ATTEMPTS + 1)
  }, 10_000)
})
