/**
 * The browser's half of `GET /api/workspaces/{name}/terminal`, against a real
 * WebSocket server and the real xterm.js: every frame below crossed a socket,
 * and what the screen shows is what xterm.js drew. A hand-written socket would
 * only ever prove that the stub matches the code driving it.
 *
 * The URL is fixed because the page builds its own from `location`, and the
 * server has to be where the component will look.
 *
 * @vitest-environment-options { "url": "http://127.0.0.1:57130/" }
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { type WebSocket as Client, WebSocket as Ws, WebSocketServer } from 'ws'
import { Terminal } from './components/Terminal'

const PORT = 57130

type Frame = { text: string } | { bytes: number[] }

/** Enough of the daemon to hold up its end: it takes the frames the page
 *  sends, and says whatever a test tells it to. */
function daemon() {
  const server = new WebSocketServer({ port: PORT })
  const heard: Frame[] = []
  const asked: string[] = []
  let live: Client | undefined
  let closed = false

  server.on('connection', (socket, request) => {
    live = socket
    asked.push(request.url ?? '')
    socket.on('message', (data: Buffer, binary: boolean) => {
      heard.push(binary ? { bytes: [...data] } : { text: data.toString() })
    })
    socket.on('close', () => {
      closed = true
    })
  })

  return {
    heard,
    asked,
    ended: () => closed,
    print: (bytes: string) => live?.send(Buffer.from(bytes), { binary: true }),
    say: (text: string) => live?.send(text, { binary: false }),
    hangUp: () => live?.close(),
    // `close` stops the listener and waits for the sockets on it, so the
    // clients have to be let go before it can finish.
    stop: () =>
      new Promise((done) => {
        for (const socket of server.clients) socket.terminate()
        server.close(() => done(null))
      }),
  }
}

/** Two things jsdom cannot do for a terminal, and the second one is a trap.
 *
 *  xterm.js asks for the legacy `MediaQueryList.addListener` on the device
 *  pixel ratio, and jsdom has no `matchMedia` at all — as `dashboard.test.tsx`
 *  records for the width query.
 *
 *  **jsdom's own `WebSocket` cannot connect under vitest**: jsdom builds it on
 *  undici's, undici constructs the global `Event`, and the jsdom environment
 *  has replaced that class — so a real handshake dies in `dispatchEvent` with
 *  *"must be an instance of Event. Received an instance of Event"* and the
 *  socket times out. `ws`'s client is a second RFC-6455 implementation rather
 *  than a stand-in for this one: it really connects to the server below, so
 *  every frame asserted here crossed a socket. */
function browser() {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
  vi.stubGlobal('WebSocket', Ws)
}

const screenText = () =>
  document.querySelector('.xterm-rows')?.textContent ?? ''

const first = (heard: Frame[]) =>
  'text' in heard[0] ? (JSON.parse(heard[0].text) as unknown) : heard[0]

let daemonised: ReturnType<typeof daemon>

beforeEach(() => {
  browser()
  daemonised = daemon()
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await daemonised.stop()
})

describe('the terminal in the dashboard', () => {
  it('says how big it is and what it is before anything else', async () => {
    render(<Terminal name="yantra" onClose={() => {}} />)

    await waitFor(() => expect(daemonised.heard.length).toBe(1))
    expect(daemonised.asked).toEqual(['/api/workspaces/yantra/terminal'])
    // A pty is opened with a window and a terminal, so this frame is what
    // starts the session rather than what adjusts it.
    expect(first(daemonised.heard)).toEqual({
      rows: expect.any(Number),
      cols: expect.any(Number),
      term: 'xterm-256color',
    })
  })

  it('draws what the session printed, and never what the daemon said about it', async () => {
    render(<Terminal name="yantra" onClose={() => {}} />)
    await waitFor(() => expect(daemonised.heard.length).toBe(1))

    daemonised.print('claude is thinking')
    await waitFor(() => expect(screenText()).toContain('claude is thinking'))

    // Text from the daemon is why a terminal could not be opened, so it is
    // said beside the screen and never printed onto it.
    daemonised.say('ssh: connect to host cachyos-g14 port 22: No route to host')
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'No route to host',
      ),
    )
    expect(screenText()).not.toContain('No route')
  })

  it('sends what is typed as bytes, ^C included', async () => {
    render(<Terminal name="yantra" onClose={() => {}} />)
    await waitFor(() => expect(daemonised.heard.length).toBe(1))

    document.querySelector('.xterm-helper-textarea')?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        keyCode: 67,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )

    await waitFor(() => expect(daemonised.heard.length).toBe(2))
    expect(daemonised.heard[1]).toEqual({ bytes: [0x03] })
  })

  it('says the window changed rather than letting the far side guess', async () => {
    render(<Terminal name="yantra" onClose={() => {}} />)
    await waitFor(() => expect(daemonised.heard.length).toBe(1))

    window.dispatchEvent(new Event('resize'))

    await waitFor(() => expect(daemonised.heard.length).toBe(2))
    expect(daemonised.heard[1]).toEqual(daemonised.heard[0])
  })

  it('ends the socket when it is closed, so nothing is left attached', async () => {
    const { unmount } = render(<Terminal name="yantra" onClose={() => {}} />)
    await waitFor(() => expect(daemonised.heard.length).toBe(1))

    unmount()
    await waitFor(() => expect(daemonised.ended()).toBe(true))
  })

  /** Y-132's starting point: a socket that goes away is not an error, and the
   *  session it was attached to is still running. */
  it('says a socket that ended with no reason differently from one that gave one', async () => {
    render(<Terminal name="yantra" onClose={() => {}} />)
    await waitFor(() => expect(daemonised.heard.length).toBe(1))

    daemonised.hangUp()
    await waitFor(() =>
      expect(screen.getByText(/The terminal ended/)).toBeTruthy(),
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
