/**
 * Test only. A real `ws` server and the two globals jsdom cannot supply, for
 * the suites that drive a terminal socket. Every frame a test asserts against
 * this crossed a socket; a hand-written stub would only prove the stub matches
 * the code driving it.
 */
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { vi } from 'vitest'
import { type WebSocket as Client, WebSocket as Ws, WebSocketServer } from 'ws'
import type { FormFactor } from '@/shell/formFactor'

export type Frame = { text: string } | { bytes: number[] }

/** Enough of the daemon to hold up its end: it takes the frames the page
 *  sends, and says whatever a test tells it to. */
export async function daemon() {
  // Port 0 is the kernel's choice, and it is already bound by the time the
  // number can be read — nothing can take it in between.
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  const heard: Frame[] = []
  const asked: string[] = []
  let live: Client | undefined
  let closed = false
  let refusing = false

  server.on('connection', (socket, request) => {
    live = socket
    asked.push(request.url ?? '')
    if (refusing) {
      socket.close()
      return
    }
    socket.on('message', (data: Buffer, binary: boolean) => {
      heard.push(binary ? { bytes: [...data] } : { text: data.toString() })
    })
    socket.on('close', () => {
      closed = true
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    heard,
    asked,
    ended: () => closed,
    print: (bytes: string) => live?.send(Buffer.from(bytes), { binary: true }),
    say: (text: string) => live?.send(text, { binary: false }),
    hangUp: () => live?.close(),
    /** A daemon that takes the connection and drops it having said nothing —
     *  which is the one shape the page cannot tell from a network that went
     *  away, and so the one it must stop retrying by counting. */
    keepHangingUp: () => {
      refusing = true
    },
    // `close` stops the listener and waits for the sockets on it, so the
    // clients have to be let go before it can finish.
    stop: () =>
      new Promise((done) => {
        for (const socket of server.clients) socket.terminate()
        server.close(() => done(null))
      }),
  }
}

const WIDTH: Record<FormFactor, number> = { phone: 390, tablet: 834, desktop: 1440 }

/** Two things jsdom cannot do for a terminal, and the second one is a trap.
 *
 *  xterm.js asks for the legacy `MediaQueryList.addListener` on the device
 *  pixel ratio, and jsdom has no `matchMedia` at all.
 *
 *  **jsdom's own `WebSocket` cannot connect under vitest**: jsdom builds it on
 *  undici's, undici constructs the global `Event`, and the jsdom environment
 *  has replaced that class — so a real handshake dies in `dispatchEvent` with
 *  *"must be an instance of Event. Received an instance of Event"* and the
 *  socket times out. `ws`'s client is a second RFC-6455 implementation rather
 *  than a stand-in for this one: it really connects to the server above.
 *
 *  `size` answers the shell's width queries, so a view whose copy is shorter
 *  on the phone can be mounted at 390 as well. */
export function browser(size: FormFactor = 'desktop') {
  const width = WIDTH[size]
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
  vi.stubGlobal('WebSocket', Ws)
}
