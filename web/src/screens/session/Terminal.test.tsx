/**
 * The browser's half of `GET /api/workspaces/{name}/terminal` and of
 * `GET /api/machines/{machine}/sessions/{session}/terminal`, against a real
 * WebSocket server and the real xterm.js: every frame below crossed a socket,
 * and what the screen shows is what xterm.js drew. A hand-written socket would
 * only ever prove that the stub matches the code driving it.
 *
 * The page builds its own URL from `location`, so the server has to be where
 * the component will look. The OS says where that is, and the page is moved to
 * it — a port named here is one this machine may already be using.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { ATTEMPTS, PAUSE, type Target } from '@/api/socket'
import { renderRouted } from '@/test/inRouter'
import { browser, daemon, type Frame } from './harness'
import { KeyRow } from './Keys'
import { Terminal } from './Terminal'

/** Every refusal names its machine and links to it (D5 §7), so the component
 *  wants a router. One call site keeps the props in one place. */
const MACHINE = 'cachyos-g14'

const label = (target: Target) =>
  'workspace' in target ? `tmux ${target.workspace} on ${target.machine}` : `tmux ${target.session} on ${target.machine}`

const open = (target: Target = { machine: MACHINE, workspace: 'yantra' }) =>
  renderRouted(<Terminal label={label(target)} target={target} />)

/** A real handshake against a real `ws` server, so the wait is I/O and not a
 *  render. One second is testing-library's default and it is not enough on a
 *  loaded machine: R-24 is this file failing about two runs in three while
 *  twelve suites and a build ran beside it. */
const settled = <T,>(check: () => T) => waitFor(check, { timeout: 10_000 })

const screenText = () =>
  document.querySelector('.xterm-rows')?.textContent ?? ''

/** A key on the pane's own textarea, which is where xterm listens. */
const press = (area: HTMLElement, key: string, keyCode: number) =>
  area.dispatchEvent(
    new KeyboardEvent('keydown', { key, code: key, keyCode, bubbles: true, cancelable: true }),
  )

const first = (heard: Frame[]) =>
  'text' in heard[0] ? (JSON.parse(heard[0].text) as unknown) : heard[0]

let daemonised: Awaited<ReturnType<typeof daemon>>

beforeEach(async () => {
  browser()
  daemonised = await daemon()
  vi.stubGlobal('location', new URL(`http://127.0.0.1:${daemonised.port}/`))
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await daemonised.stop()
})

describe('the terminal in the dashboard', () => {
  it('says how big it is and what it is before anything else', async () => {
    await open()

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
    await open()
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
    await open()
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
    await open()
    await settled(() => expect(daemonised.heard.length).toBe(1))

    window.dispatchEvent(new Event('resize'))

    await settled(() => expect(daemonised.heard.length).toBe(2))
    expect(daemonised.heard[1]).toEqual(daemonised.heard[0])
  })

  /** Closing is the one end that means it — nothing is left attached, and
   *  nothing is reopened. */
  it('ends the socket when it is closed, and does not reopen it', async () => {
    const { unmount } = await open()
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
    await open()
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
    expect(screen.queryByText(/attempts to reopen/)).toBeNull()
  })

  /** **D3 §7.3.** The box is black either way, so the status line under it has
   *  to say which of the two it is doing (SessionTerminal.dc.html). */
  it('says it is connecting until the socket opens, then that it is attached', async () => {
    await open()

    // A handshake cannot have finished in the same turn as the render, so this
    // is the state a slow network holds for as long as it takes.
    expect(screen.getByRole('status').textContent).toContain(
      'connecting · tmux yantra on cachyos-g14',
    )

    await settled(() => expect(daemonised.heard.length).toBe(1))
    await settled(() =>
      expect(screen.getByRole('status').textContent).toContain('attached'),
    )
    // The board's status line carries the window size beside the name.
    expect(screen.getByRole('status').textContent).toMatch(/\d+×\d+/)
  })

  /** **WCAG 2.1.2, and the reason the pane is not a trap.** Tab is the shell's:
   *  it goes down the socket and moves no focus. Escape is the shell's too.
   *  Only the pair leaves, and it leaves to the status line under the pane. */
  it('sends Tab and Escape to the shell, and leaves the pane on Escape then Tab', async () => {
    await open()
    await settled(() => expect(daemonised.heard.length).toBe(1))
    const area = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    area.focus()

    press(area, 'Tab', 9)
    await settled(() => expect(daemonised.heard.length).toBe(2))
    expect(daemonised.heard[1]).toEqual({ bytes: [0x09] })
    expect(document.activeElement).toBe(area)

    press(area, 'Escape', 27)
    await settled(() => expect(daemonised.heard.length).toBe(3))
    expect(daemonised.heard[2]).toEqual({ bytes: [0x1b] })

    press(area, 'Tab', 9)
    expect(document.activeElement).toBe(screen.getByRole('status'))
    // The Tab that left was not also typed into the session.
    expect(daemonised.heard.length).toBe(3)
  })

  /** **Row 134.** xterm measures the cell once, against whatever face is live
   *  then, and caches it: `fit()` afterwards only divides the container by a
   *  stale cell, and reassigning the same `fontFamily` is a no-op, so a face
   *  that lands late leaves the pane the wrong width for good. A pty is opened
   *  with that width, so the far side wraps where the shell did not.
   *
   *  `fonts.ready` alone did not hold it — it settles on the loads already
   *  pending, and nothing on this route asks for the face until the pane draws.
   *  The assertion is that the pane asks, and waits, before it measures. */
  it('asks for the mono face before it measures a cell', async () => {
    const asked: string[] = []
    let arrive = () => {}
    const face = new Promise<void>((done) => {
      arrive = done
    })
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        load: (spec: string) => {
          asked.push(spec)
          return face
        },
        ready: Promise.resolve(),
      },
    })

    try {
      await open()
      expect(asked).toEqual(['13px "IBM Plex Mono"'])
      // Nothing crossed the socket while the face was outstanding.
      expect(daemonised.heard.length).toBe(0)

      arrive()
      await settled(() => expect(daemonised.heard.length).toBe(1))
    } finally {
      Reflect.deleteProperty(document, 'fonts')
    }
  })

  /** **2.4.3 and 3.2.1.** The fonts resolve after the page has settled, and a
   *  pane that took focus then moved it without being asked. */
  it('does not take focus when the fonts resolve', async () => {
    await open()
    await settled(() => expect(daemonised.heard.length).toBe(1))
    expect(document.activeElement).toBe(document.body)
  })

  it('names which attempt of how many it is on while it reconnects', async () => {
    await open()
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.keepHangingUp()
    daemonised.hangUp()

    await settled(() =>
      expect(screen.getByRole('status').textContent).toContain(
        `reconnecting · attempt 1 of ${ATTEMPTS}`,
      ),
    )
    // The number moves, which is the whole point of printing it: two seconds of
    // silence and two seconds of counting are different things to sit through.
    await waitFor(
      () =>
        expect(screen.getByRole('status').textContent).toContain(
          `reconnecting · attempt 2 of ${ATTEMPTS}`,
        ),
      { timeout: PAUSE * 4 },
    )
  }, 10000)

  /** A reason from the daemon is a refusal — the workspace has no session, the
   *  machine is asleep — and reopening a refused socket only refuses again. */
  it('does not reopen a socket the daemon gave a reason for', async () => {
    await open()
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.say('ssh: connect to host cachyos-g14 port 22: No route to host')
    await settled(() => expect(screen.getByRole('alert')).toBeTruthy())
    // D5 §7: this tab's own refusal names the machine, and the name is the link
    // to where its heartbeat is.
    expect(screen.getByRole('alert').textContent).toContain(MACHINE)
    expect(
      screen.getByRole('link', { name: MACHINE }).getAttribute('href'),
    ).toBe(`/m/${MACHINE}`)
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
    await open()
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.keepHangingUp()
    daemonised.hangUp()

    await waitFor(
      () => expect(screen.getByText(/attempts to reopen/)).toBeTruthy(),
      { timeout: PAUSE * (ATTEMPTS + 4) },
    )
    expect(screen.queryByRole('alert')).toBeNull()
    // A spent budget is an end state rather than a pane that went quiet: it
    // counts what it tried, and it does not claim to know which side failed.
    const said = screen.getByText(/attempts to reopen/).textContent ?? ''
    expect(said).toContain(`${ATTEMPTS} attempts`)
    expect(said).toContain('not something this page can tell')
    // D5 §7 again: a spent budget names the machine it could not get back to,
    // and leaves it a link.
    expect(said).toContain(MACHINE)
    expect(
      screen.getByRole('link', { name: MACHINE }).getAttribute('href'),
    ).toBe(`/m/${MACHINE}`)
    // 4.1.3: the line that has been speaking all along is the one that has to
    // carry the end, so it stays rather than going with what ended it.
    expect(screen.getByRole('status').textContent).toContain('ended · tmux yantra on cachyos-g14')
    // The first socket, then the five it is worth reopening.
    expect(daemonised.asked.length).toBe(ATTEMPTS + 1)
  }, 10000)
})

/** **Y-179.** One bridge, two addresses (ADR-0022). Nothing below is a second
 *  terminal: it is the same component, told a machine and a session instead of
 *  a workspace, and what changes is the URL it opens and the name it says. */
describe('the same terminal on a session no workspace claims', () => {
  const scratch = { machine: 'pi', session: 'scratch' } as const

  it('asks for the machine and the session rather than for a workspace', async () => {
    await open(scratch)

    await settled(() => expect(daemonised.heard.length).toBe(1))
    expect(daemonised.asked).toEqual([
      '/api/machines/pi/sessions/scratch/terminal',
    ])
    expect(first(daemonised.heard)).toEqual({
      rows: expect.any(Number),
      cols: expect.any(Number),
      term: 'xterm-256color',
    })
  })

  it('names the session and the machine on the status line', async () => {
    await open(scratch)

    expect(screen.getByRole('status').textContent).toContain('tmux scratch on pi')
    // `ws` throws on a socket torn down mid-handshake, so the connection is
    // let finish before the test ends and cleanup unmounts it.
    await settled(() => expect(daemonised.heard.length).toBe(1))
  })

  /** ADR-0022 §5: the socket attaches and never creates, so a session that went
   *  away between the list and the tap is the ordinary case. The refusal has to
   *  reach the screen — an empty black box, or a spinner that never resolves,
   *  reads as a terminal still connecting. */
  it('draws a session that is gone as a refusal naming it, not as an empty pane', async () => {
    await open(scratch)
    await settled(() => expect(daemonised.heard.length).toBe(1))

    daemonised.say("tmux: can't find session: =scratch")

    await settled(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'scratch on pi has no terminal to attach to',
      ),
    )
    // The daemon's own chain is beside the name rather than instead of it.
    expect(screen.getByRole('alert').textContent).toContain("can't find session")
    expect(screen.getByRole('status').textContent).toContain('refused · tmux scratch on pi')
    // No workspace is invented for a session that has none.
    expect(document.body.textContent).not.toContain('Workspaces row')
  })
})

/** **PhoneSessionTerminal's key row.** It is drawn inside the pane's own
 *  context, so what it sends and what the pane does with it are one test. */
describe('the phone key row under the pane', () => {
  const target: Target = { machine: MACHINE, workspace: 'yantra' }

  const openKeys = () =>
    renderRouted(
      <Terminal label={label(target)} target={target}>
        <KeyRow />
      </Terminal>,
    )

  const keys = () => within(screen.getByRole('toolbar', { name: 'Keys' })).getAllByRole('button')

  /** **4.1.2, finding 108.** A toolbar is one tab stop with the arrow keys
   *  moving inside it; seven tab stops is a role the widget did not implement. */
  it('holds one tab stop, and the arrow keys walk it', async () => {
    await openKeys()
    await settled(() => expect(daemonised.heard.length).toBe(1))

    const row = screen.getByRole('toolbar', { name: 'Keys' })
    expect(keys().map((one) => one.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1])

    fireEvent.keyDown(row, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(keys()[1])
    expect(keys().map((one) => one.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1, -1])

    // The ends meet: Left twice from the second key is the last key.
    fireEvent.keyDown(row, { key: 'ArrowLeft' })
    fireEvent.keyDown(row, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(keys()[6])
  })

  /** **Finding 119.** Ctrl focuses the pane, and that blurred the button while
   *  the pane stayed armed — the mark said off and the next key was still a
   *  control code. The pane clears the mark when it spends the arm. */
  it('keeps Ctrl marked until the pane spends it', async () => {
    await openKeys()
    await settled(() => expect(daemonised.heard.length).toBe(1))
    const ctrl = keys()[4]!

    fireEvent.click(ctrl)
    expect(ctrl.getAttribute('aria-pressed')).toBe('true')

    const area = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    press(area, 'a', 65)

    await settled(() => expect(daemonised.heard.length).toBe(2))
    expect(daemonised.heard[1]).toEqual({ bytes: [0x01] })
    await settled(() => expect(ctrl.getAttribute('aria-pressed')).toBe('false'))
  })
})
