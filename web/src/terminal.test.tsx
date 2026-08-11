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
import { ATTEMPTS, PAUSE, Terminal } from './components/Terminal'

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

/** A real handshake against a real `ws` server, so the wait is I/O and not a
 *  render. One second is testing-library's default and it is not enough on a
 *  loaded machine: R-24 is this file failing about two runs in three while
 *  twelve suites and a build ran beside it. */
const settled = <T,>(check: () => T) => waitFor(check, { timeout: 10_000 })

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

    await settled(() => expect(daemonised.heard.length).toBe(1))
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
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.print('claude is thinking')
    await settled(() => expect(screenText()).toContain('claude is thinking'))

    // Text from the daemon is why a terminal could not be opened, so it is
    // said beside the screen and never printed onto it.
    daemonised.say('ssh: connect to host cachyos-g14 port 22: No route to host')
    await settled(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'No route to host',
      ),
    )
    expect(screenText()).not.toContain('No route')
  })

  it('sends what is typed as bytes, ^C included', async () => {
    render(<Terminal name="yantra" onClose={() => {}} />)
    await settled(() => expect(daemonised.heard.length).toBe(1))

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

    await settled(() => expect(daemonised.heard.length).toBe(2))
    expect(daemonised.heard[1]).toEqual({ bytes: [0x03] })
  })

  it('says the window changed rather than letting the far side guess', async () => {
    render(<Terminal name="yantra" onClose={() => {}} />)
    await settled(() => expect(daemonised.heard.length).toBe(1))

    window.dispatchEvent(new Event('resize'))

    await settled(() => expect(daemonised.heard.length).toBe(2))
    expect(daemonised.heard[1]).toEqual(daemonised.heard[0])
  })

  /** Closing is the one end that means it — nothing is left attached, and
   *  nothing is reopened. */
  it('ends the socket when it is closed, and does not reopen it', async () => {
    const { unmount } = render(<Terminal name="yantra" onClose={() => {}} />)
    await settled(() => expect(daemonised.heard.length).toBe(1))

    unmount()
    await settled(() => expect(daemonised.ended()).toBe(true))

    await new Promise((done) => setTimeout(done, PAUSE * 3))
    expect(daemonised.asked.length).toBe(1)
  })

  /** **Y-132.** Nothing here replays anything: the page opens another socket,
   *  and the tmux on the far side draws the pane for whichever client attaches
   *  next. What this proves is the half the browser owns — that a socket which
   *  went away with nothing to say is reopened, and told the window again,
   *  because a pty is opened with one. */
  it('reopens a socket that dropped, and says how big it is on the new one', async () => {
    render(<Terminal name="yantra" onClose={() => {}} />)
    await settled(() => expect(daemonised.heard.length).toBe(1))
    daemonised.print('claude is thinking')
    await settled(() => expect(screenText()).toContain('claude is thinking'))

    daemonised.hangUp()

    await settled(() => expect(daemonised.asked.length).toBe(2))
    expect(daemonised.asked[1]).toBe('/api/workspaces/yantra/terminal')
    await settled(() => expect(daemonised.heard.length).toBe(2))
    expect(daemonised.heard[1]).toEqual(daemonised.heard[0])

    daemonised.print('and it is still thinking')
    await settled(() =>
      expect(screenText()).toContain('and it is still thinking'),
    )
    expect(screen.queryByText(/The terminal ended/)).toBeNull()
  })

  /** **D3 §7.3.** The box is black either way, so the socket has to say which
   *  of the two it is doing. */
  it('says it is connecting until the socket opens', async () => {
    render(<Terminal name="yantra" onClose={() => {}} />)

    // A handshake cannot have finished in the same turn as the render, so this
    // is the state a slow network holds for as long as it takes.
    expect(screen.getByRole('status').textContent).toBe('Connecting…')

    await settled(() => expect(daemonised.heard.length).toBe(1))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('names which attempt of how many it is on while it reconnects', async () => {
    render(<Terminal name="yantra" onClose={() => {}} />)
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.keepHangingUp()
    daemonised.hangUp()

    await settled(() =>
      expect(screen.getByRole('status').textContent).toBe(
        `Reconnecting, attempt 1 of ${ATTEMPTS}.`,
      ),
    )
    // The number moves, which is the whole point of printing it: two seconds of
    // silence and two seconds of counting are different things to sit through.
    await waitFor(
      () =>
        expect(screen.getByRole('status').textContent).toBe(
          `Reconnecting, attempt 2 of ${ATTEMPTS}.`,
        ),
      { timeout: PAUSE * 4 },
    )
  }, 10000)

  /** A reason from the daemon is a refusal — the workspace has no session, the
   *  machine is asleep — and reopening a refused socket only refuses again. */
  it('does not reopen a socket the daemon gave a reason for', async () => {
    render(<Terminal name="yantra" onClose={() => {}} />)
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.say('ssh: connect to host cachyos-g14 port 22: No route to host')
    await settled(() => expect(screen.getByRole('alert')).toBeTruthy())
    daemonised.hangUp()

    // Proving a thing does not happen needs a window: this is the whole of the
    // retry budget with room to spare.
    await new Promise((done) => setTimeout(done, PAUSE * (ATTEMPTS + 2)))
    expect(daemonised.asked.length).toBe(1)
  })

  /** **The cap, and it is a cap on attempts rather than on anything kept.**
   *  Every one of them is an `ssh` connection and a tmux client on a machine
   *  that may be asleep, so a terminal that cannot be got back has to stop
   *  asking — and say so differently from a terminal that was refused. */
  it('gives up after a bounded number of attempts rather than reopening forever', async () => {
    render(<Terminal name="yantra" onClose={() => {}} />)
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.keepHangingUp()
    daemonised.hangUp()

    await waitFor(
      () => expect(screen.getByText(/The terminal ended/)).toBeTruthy(),
      { timeout: PAUSE * (ATTEMPTS + 4) },
    )
    expect(screen.queryByRole('alert')).toBeNull()
    // A spent budget is an end state rather than a pane that went quiet: it
    // counts what it tried, and it does not claim to know which side failed.
    const said = screen.getByText(/The terminal ended/).textContent ?? ''
    expect(said).toContain(`${ATTEMPTS} attempts`)
    expect(said).toContain('not something this page can tell')
    expect(screen.queryByRole('status')).toBeNull()
    // The first socket, then the five it is worth reopening.
    expect(daemonised.asked.length).toBe(ATTEMPTS + 1)
  }, 10000)
})
