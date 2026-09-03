/**
 * The transcript tab of `/w/{name}` — D5 §4, Y-309.
 *
 * **The far side is a real file.** `farSide` writes one record per line and
 * answers a read by the daemon's own arithmetic, `tail -n {lines + before} |
 * head -n {lines}` over what is on disk.
 *
 * The records are turns the daemon already projected, so the file stands in for
 * the far side's selection and not for Claude Code's format.
 */
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { Listed, Looked, Transcript, Turn } from './api'
import App from './App'
import { logs } from './contract.gen'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
})

beforeEach(() => {
  // TanStack Router scrolls on navigation and jsdom implements no `scrollTo`.
  vi.stubGlobal('scrollTo', () => {})
})

const yantra: Listed = {
  loaded: 'yes',
  name: 'yantra',
  machine: 'cachyos-g14',
  repo: '/home/<user>/Github/homelab/yantra',
  startup: null,
}

const LOGS = '/api/workspaces/yantra/logs'

type Reply = { status: number; body: unknown }
type Window = { lines: number; before: number }
/** What the logs route answers one window with — a promise where a test wants
 *  to hold the ssh open and see what the page draws meanwhile. */
type Said = (window: Window) => Reply | Promise<Reply>

const answered = ({ status, body }: Reply) => ({
  ok: status < 400,
  status,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(String(body)),
})

const looked = <T,>(data: T): Looked<T> => ({
  looked: 'ok',
  age_seconds: 1,
  data,
})

/** One record per line, and the window the daemon would have cut out of it. */
function farSide() {
  const path = join(mkdtempSync(join(tmpdir(), 'yantra-logs-')), 'session.jsonl')
  writeFileSync(path, '')

  const records = () =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')

  return {
    path,
    append(...turns: Turn[]) {
      appendFileSync(path, turns.map((turn) => `${JSON.stringify(turn)}\n`).join(''))
    },
    read({ lines, before }: Window): Transcript {
      const held = records()
      const end = Math.max(0, held.length - before)
      return {
        path,
        total: held.length,
        turns: held
          .slice(Math.max(0, end - lines), end)
          .map((line) => JSON.parse(line) as Turn),
      }
    },
  }
}

/** The workspace list, and whatever the logs route is told to answer. Every
 *  other path answers `never`, so a reading added to the page later cannot fail
 *  this file for a reason that is not its subject. */
function daemon(said: Said) {
  const fetched = vi.fn(
    async (path: string, init?: { method?: string; body?: string }) => {
      if (path === '/api/viewing') return { ok: true, status: 204 }
      if (path === '/api/workspaces') {
        return answered({ status: 200, body: looked([yantra]) })
      }
      if (path === LOGS && init?.method === 'POST') {
        return answered(await said(JSON.parse(init.body ?? '{}') as Window))
      }
      return answered({ status: 200, body: { looked: 'never' } })
    },
  )
  vi.stubGlobal('fetch', fetched)
  return fetched
}

const reads = (fetched: ReturnType<typeof daemon>) =>
  fetched.mock.calls.filter(([path]) => path === LOGS)

/** jsdom has no `matchMedia`. A phone lands on the transcript (D5 §3.3), which
 *  is what all but one test here wants. */
function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: /rem/.test(query)
      ? width < Number(/([\d.]+)rem/.exec(query)?.[1]) * 16
      : Number(/([\d.]+)px/.exec(query)?.[1]) <= width,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
}

/** A socket that connects to nothing, so the terminal tab costs this file
 *  nothing when a test switches to it. */
function quietSocket() {
  vi.stubGlobal(
    'WebSocket',
    class {
      static OPEN = 1
      readyState = 0
      binaryType = ''
      send() {}
      close() {}
    },
  )
}

// A phone lands on the transcript, which is where every test here starts
// (D5 §3.3).
const PHONE = 390

function open(said: Said, at = '/w/yantra') {
  const fetched = daemon(said)
  viewport(PHONE)
  quietSocket()
  history.pushState(null, '', at)
  render(<App />)
  return fetched
}

/** One turn of the agent's, which is all a window test needs to tell two
 *  records apart. */
const said = (text: string): Turn => ({ who: 'claude', at: null, text, tools: [] })

/** A file of `count` turns, numbered oldest first so a window says which one it
 *  is. */
function conversation(count: number): Turn[] {
  return Array.from({ length: count }, (_, index) => ({
    ...said(`turn ${index + 1}`),
    who: index % 2 === 0 ? ('you' as const) : ('claude' as const),
  }))
}

const turns = () => screen.getAllByRole('article').map((one) => one.textContent)

const older = () => screen.queryByRole('button', { name: 'Older' })

// xterm.js is the heaviest thing this suite draws, and one second is not always
// enough for it on a loaded machine.
const pane = () =>
  screen.findByText('Terminal — yantra', undefined, { timeout: 5_000 })

describe('the transcript is read on request', () => {
  it('reads nothing until the tab is opened', async () => {
    const file = farSide()
    file.append(...logs.turns)
    const fetched = open(
      (window) => ({ status: 200, body: file.read(window) }),
      '/w/yantra?view=spend',
    )

    // Another tab is open, so nothing has asked for the transcript.
    await screen.findByText('Spend is not built yet.')
    expect(reads(fetched)).toHaveLength(0)

    fireEvent.click(screen.getByRole('link', { name: 'transcript' }))

    expect(await screen.findByText('run the tests')).toBeTruthy()
    expect(reads(fetched)).toHaveLength(1)
    expect(reads(fetched)[0]![1]).toMatchObject({ method: 'POST' })
  })

  it('says what it is waiting for while the ssh is out', async () => {
    const file = farSide()
    file.append(...logs.turns)
    let answer = (_: Reply) => {}
    const held = new Promise<Reply>((resolve) => (answer = resolve))
    open(() => held)

    expect(
      (await screen.findByText(/reading the transcript/)).textContent,
    ).toContain('cachyos-g14')

    answer({ status: 200, body: file.read({ lines: 50, before: 0 }) })
    expect(await screen.findByText('run the tests')).toBeTruthy()
  })

  /** D5 §4.3: the answer is held for as long as the page is open, and a read is
   *  an ssh. Only the open tab is mounted, so this is the interesting case. */
  it('does not read again when you leave the tab and come back', async () => {
    const file = farSide()
    file.append(...logs.turns)
    const fetched = open((window) => ({ status: 200, body: file.read(window) }))

    await screen.findByText('run the tests')
    fireEvent.click(screen.getByRole('link', { name: 'terminal' }))
    await pane()
    fireEvent.click(screen.getByRole('link', { name: 'transcript' }))

    expect(await screen.findByText('run the tests')).toBeTruthy()
    expect(reads(fetched)).toHaveLength(1)
  })

  /** D5 §4.6: on a phone it is the one press between what happened and what is
   *  happening. */
  it('reaches the pane through Take control', async () => {
    const file = farSide()
    file.append(...logs.turns)
    open((window) => ({ status: 200, body: file.read(window) }))

    await screen.findByText('run the tests')
    fireEvent.click(screen.getByRole('link', { name: 'Take control' }))

    expect(await pane()).toBeTruthy()
    await waitFor(() => expect(location.search).toBe('?view=terminal'))
  })
})

describe('a turn', () => {
  it('says who spoke, and when the record carries a stamp', async () => {
    const file = farSide()
    file.append(...logs.turns)
    open((window) => ({ status: 200, body: file.read(window) }))

    const spoke = await screen.findByText('run the tests')
    const first = spoke.closest('article')!
    expect(first.textContent).toContain('you')
    // The timestamp as the far side wrote it, since D3 §5.7 refuses to reprint
    // a remote clock's instant in the browser's own words.
    expect(first.querySelector('time')?.getAttribute('title')).toBe(
      logs.turns[0]!.at,
    )
    expect(screen.getByText('Running them now.').closest('article')!.textContent)
      .toContain('claude')
  })

  it('prints no time for a record that carries none', async () => {
    const file = farSide()
    file.append(...logs.turns)
    open((window) => ({ status: 200, body: file.read(window) }))

    const said = await screen.findByText('Running them now.')
    expect(logs.turns[1]!.at).toBeNull()
    expect(said.closest('article')!.querySelector('time')).toBeNull()
    expect(said.closest('article')!.textContent).not.toContain('unknown')
  })

  /** D5 §4.1. The agent writes Markdown and this page renders text: a parser
   *  inside a held budget, and an XSS surface on text a machine wrote. */
  it('renders the text as text, not as Markdown', async () => {
    const file = farSide()
    file.append({
      who: 'claude',
      at: null,
      text: '**plan**\n- one\n<b>two</b>',
      tools: [],
    })
    open((window) => ({ status: 200, body: file.read(window) }))

    const said = await screen.findByText(/plan/)
    expect(said.textContent).toBe('**plan**\n- one\n<b>two</b>')
    expect(document.querySelector('strong')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
    // Whitespace is preserved, so a plan that was lines stays lines.
    expect(said.className).toContain('whitespace-pre-wrap')
  })
})

describe('a tool call', () => {
  const call = () => screen.getByRole('button', { name: /cargo nextest/ })

  it('is one line: the tool as a verb, and one target', async () => {
    const file = farSide()
    file.append(...logs.turns)
    open((window) => ({ status: 200, body: file.read(window) }))

    await screen.findByText('Running them now.')
    expect(call().textContent).toMatch(/^ran/)
    expect(call().textContent).toContain('cargo nextest run --workspace')
    // The verb, not the tool's own name — *edited Edit* says nothing (§2.1).
    expect(call().textContent).not.toContain('Bash')
    expect(call().getAttribute('aria-expanded')).toBe('false')
  })

  it('expands to the target the daemon sent', async () => {
    const file = farSide()
    file.append(...logs.turns)
    open((window) => ({ status: 200, body: file.read(window) }))

    await screen.findByText('Running them now.')
    fireEvent.click(call())

    expect(call().getAttribute('aria-expanded')).toBe('true')
    expect(
      screen.getByText('cargo nextest run --workspace').className,
    ).toContain('whitespace-pre-wrap')
  })

  /** D5 §4.2: the eight-key list misses `SendUserFile`, whose input names no
   *  target — so there is nothing to expand to and no control that says there
   *  is. */
  it('renders a call with no target as its name alone', async () => {
    const file = farSide()
    file.append(...logs.turns)
    open((window) => ({ status: 200, body: file.read(window) }))

    await screen.findByText('Running them now.')
    expect(screen.getByText('SendUserFile')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'SendUserFile' })).toBeNull()
  })
})

describe('Older walks the window back', () => {
  const file = farSide()

  beforeEach(() => {
    writeFileSync(file.path, '')
    file.append(...conversation(120))
  })

  /** D5 §2.3 and §4.4: `lines` counts records, and the page may never promise
   *  turns — so the count line is in records and says which unit it is in. */
  it('says how many records it holds, of how many there are', async () => {
    open((window) => ({ status: 200, body: file.read(window) }))

    expect(await screen.findByText('the last 50 of 120 records')).toBeTruthy()
    expect(turns()).toHaveLength(50)
  })

  it('prepends the next window back, oldest first', async () => {
    open((window) => ({ status: 200, body: file.read(window) }))

    await screen.findByText('turn 120')
    expect(turns()[0]).toContain('turn 71')

    fireEvent.click(older()!)

    await screen.findByText('turn 21')
    // Disjoint windows, so the page prepends and stitches nothing.
    expect(turns()).toHaveLength(100)
    expect(turns()[0]).toContain('turn 21')
    expect(turns()[99]).toContain('turn 120')
    expect(screen.getByText('the last 100 of 120 records')).toBeTruthy()
  })

  /** Past the start of the file `tail` stops skipping, so a full window would
   *  repeat what is drawn. `total` is what says to stop asking. */
  it('asks for what is left, then stops offering Older', async () => {
    const fetched = open((window) => ({ status: 200, body: file.read(window) }))

    await screen.findByText('turn 120')
    fireEvent.click(older()!)
    await screen.findByText('turn 21')
    fireEvent.click(older()!)
    await screen.findByText('turn 1')

    expect(reads(fetched)[2]![1]!.body).toBe(
      JSON.stringify({ lines: 20, before: 100 }),
    )
    expect(turns()).toHaveLength(120)
    expect(screen.getByText('the last 120 of 120 records')).toBeTruthy()
    expect(older()).toBeNull()
  })
})

/** D5 §4.3. A stamp that never moves is the lie the stamp exists to prevent,
 *  and this page re-renders for no other reason. */
describe('the stamp', () => {
  it('moves on a clock that fetches nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const file = farSide()
    file.append(...logs.turns)
    const fetched = open((window) => ({ status: 200, body: file.read(window) }))

    await screen.findByText('run the tests')
    // `getByText` reads a node's own text children, so this matches the label
    // and `textContent` is what the clock wrote into it.
    const aged = () =>
      Number(/(\d+)s/.exec(screen.getByText(/^read/).textContent ?? '')?.[1])
    const first = aged()
    const spent = fetched.mock.calls.length

    // Under the 5 s poll and the 20 s beacon, so nothing else may re-render
    // this page or reach the daemon inside the window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })

    expect(aged()).toBeGreaterThanOrEqual(first + 3)
    expect(fetched.mock.calls).toHaveLength(spent)
    expect(reads(fetched)).toHaveLength(1)
  })
})

/** D5 §4.5. None of these is drawn as a failure, which is what makes the
 *  distinction visible at all. */
describe('what the transcript says when it has nothing', () => {
  const answering = (reply: Reply) => open(() => reply)

  it('draws a machine with no transcript as an answer, not a failure', async () => {
    answering({
      status: 409,
      body: "no agent transcript for `/srv/site` on that machine — one appears on the agent's first message, not when it launches",
    })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('No agent has written a turn here.')
    expect(alert.textContent).toContain(
      "A transcript appears on the agent's first message, not when it launches.",
    )
    expect(alert.className).not.toContain('destructive')
  })

  it('names the session that has written nothing yet', async () => {
    answering({
      status: 409,
      body: 'the agent in `/srv/site` has written no turn yet — its transcript appears on its first message, not when it launches (session 1f0c1a2e)',
    })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('No agent has written a turn here.')
    expect(alert.textContent).toContain('session 1f0c1a2e')
    expect(alert.className).not.toContain('destructive')
  })

  /** A workspace that has never run is not an error either: the daemon answers
   *  the same 409, and the page says the same thing. */
  it('says the same for a workspace with no session at all', async () => {
    answering({
      status: 409,
      body: "no agent transcript for `/srv/fresh` on that machine — one appears on the agent's first message, not when it launches",
    })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('No agent has written a turn here.')
    expect(alert.className).not.toContain('destructive')
  })

  it("keeps the daemon's whole chain when the read failed", async () => {
    answering({
      status: 503,
      body: 'ssh to cachyos-g14 failed before the command reported a status: ssh: connect to host cachyos-g14 port 22: No route to host',
    })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The transcript could not be read.')
    // The machine, the command and what ssh said are the actionable half.
    expect(alert.textContent).toContain('cachyos-g14')
    expect(alert.textContent).toContain('No route to host')
    expect(alert.className).toContain('destructive')
  })
})
