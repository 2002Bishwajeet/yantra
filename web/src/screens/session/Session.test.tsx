/**
 * `/w/{name}` before any socket is opened: which of the three views the URL
 * picks, and the three answers that are not a session at all — a name no
 * workspace carries, a file that will not load, and a list that could not be
 * read. Chat's own socket has its own suite (`Chat.test.tsx`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { keys } from '@/api/keys'
import { renderInApp } from '@/test/inApp'
import { answer } from '@/test/daemon'
import type { View } from '@/views'
import { Workspace } from './Session'

const workspaces = [
  { loaded: 'yes', name: 'landing', machine: 'macbook', repo: '/Users/biswa/Github/yantra-landing', startup: null },
  {
    loaded: 'no',
    name: 'price-table',
    error: "workspace `price-table` will not load: missing field 'machine' at line 7",
  },
]

const looked = (data: unknown) => ({ looked: 'ok', age_seconds: 0, data })

const status = looked({
  workspace: 'landing',
  machine: 'macbook',
  reached: 'yes',
  status: { state: 'running' },
  session: { id: 'c3d4e5f6', pid: 9107 },
})

const sessions = looked([
  {
    machine: 'macbook',
    reached: 'yes',
    sessions: [
      { name: 'landing', windows: 1, attached: 0, created: 'Sun Sep  6 08:19:00 2026', created_at: 1_788_683_940 },
    ],
  },
])

/** Answers the reads this screen makes, and `tokens` — the one write the Spend
 *  view sends, since reading spend costs an ssh and only happens on request
 *  (ADR-0019). */
function daemon(list: unknown = looked(workspaces), agent: unknown = status) {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? 'GET'} ${path.split('?')[0]}`)
      if (path.endsWith('/tokens')) return Promise.resolve(answer(200, contract.spend))
      if (path.endsWith('/logs')) return Promise.resolve(answer(200, contract.logs))
      if (path.includes('/status')) return Promise.resolve(answer(200, agent))
      if (path.endsWith('/api/sessions')) return Promise.resolve(answer(200, sessions))
      if (path.endsWith('/api/workspaces')) return Promise.resolve(answer(200, list))
      return Promise.resolve(answer(404, 'no'))
    }),
  )
  return asked
}

const open = (name: string, view: View = 'spend') =>
  renderInApp(
    <Workspace name={name} view={view} />,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  )

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: /min-width: (600|1240)px/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    // xterm.js still asks for the legacy pair on the device-pixel-ratio query.
    addListener: () => {},
    removeListener: () => {},
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('one workspace, three views the URL carries', () => {
  it('names the session once, with where it lives and the verbs that are live', async () => {
    daemon()
    await open('landing')

    // The list is read before anything is drawn, so the header waits on a verb.
    await screen.findByRole('button', { name: 'Stop' })
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toBe('landing')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    // `~` for the home directory, as a shell and the boards print a path.
    expect(heading.closest('.m3-page')?.querySelector('.session__meta')?.textContent).toContain(
      'macbook · ~/Github/yantra-landing',
    )
    // A running agent can be stopped and has nothing to resume (ADR-0015); Resume waits, off, in the menu.
    expect(screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect((await screen.findByRole('menuitem', { name: /^Resume/ })).hasAttribute('data-disabled')).toBe(true)
  })

  /** **Finding 120.** A verb that is off reads as broken unless it says why,
   *  and the boards draw no line for the reason, so it is the description. */
  it('gives the verb that is off a reason, and the live one none', async () => {
    daemon()
    await open('landing')

    const stop = await screen.findByRole('button', { name: 'Stop' })
    expect(stop.getAttribute('aria-describedby')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    const resume = await screen.findByRole('menuitem', { name: /^Resume/ })
    expect(resume.textContent).toContain('Resume needs an agent that has ended, and landing is running.')
  })

  /** Y-566: one Page width for every view, so the title and the tabs never move. */
  it('draws the wide page on every view', async () => {
    daemon()
    for (const view of ['terminal', 'spend'] as const) {
      const { unmount } = await open('landing', view)
      await screen.findByRole('button', { name: 'Stop' })
      expect(document.querySelector('.m3-page.session')?.getAttribute('data-width')).toBe('wide')
      unmount()
    }
  })

  it('keeps aria-busy off the title while the workspaces load', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    await open('landing')
    const title = await screen.findByRole('heading', { level: 1 })
    expect(title.closest('[aria-busy="true"]')).toBeNull()
    expect(document.querySelector('[aria-busy="true"] [data-slot="skeleton"]')).toBeTruthy()
  })

  /** D5 §3.2: a view is navigation, so each pill is a link the browser can
   *  copy and open in a tab. Chat is first (M14 board 13). */
  it('draws the three views as links, chat first, with the open one marked', async () => {
    daemon()
    await open('landing')

    const views = await screen.findByRole('navigation', { name: 'Views' })
    const links = [...views.querySelectorAll('a')]
    expect(links.map((one) => one.textContent)).toEqual(['Chat', 'Terminal', 'Spend'])
    expect(links[0]?.getAttribute('href')).toBe('/w/landing?view=chat')
    expect(links[2]?.getAttribute('aria-current')).toBe('page')
  })

  /** ADR-0019: spend is an ssh transcript read, so it is asked for once when
   *  the view is opened and never on a timer. */
  it('asks the daemon for spend when the view opens, and only then', async () => {
    const asked = daemon()
    await open('landing')

    // One model in the answer is unpriced, so the hero counts tokens and
    // gives no dollar figure (D5 §6.2).
    await waitFor(() => expect(screen.getByText('tokens, unpriced')).toBeTruthy())
    expect(asked.filter((one) => one.endsWith('/tokens'))).toEqual([
      'POST /api/workspaces/landing/tokens',
    ])
  })

  /** Y-356: closing the chat socket cancels Claude's turn, so a look at
   *  another view must leave it open. */
  it('keeps the chat socket open while another view is shown', async () => {
    daemon()
    const sockets: { url: string; closed: boolean }[] = []
    vi.stubGlobal(
      'WebSocket',
      class {
        static OPEN = 1
        readyState = 0
        record: { url: string; closed: boolean }
        constructor(url: string) {
          this.record = { url, closed: false }
          sockets.push(this.record)
        }
        send() {}
        close() {
          this.record.closed = true
        }
      },
    )
    const control: { show: (view: View) => void } = { show: () => {} }
    function Switch() {
      const [view, setView] = useState<View>('chat')
      useEffect(() => {
        control.show = setView
      }, [setView])
      return <Workspace name="landing" view={view} />
    }
    await renderInApp(<Switch />, new QueryClient({ defaultOptions: { queries: { retry: false } } }))

    await waitFor(() => expect(sockets.map((one) => one.url).join()).toContain('/chat'))
    act(() => control.show('spend'))
    await screen.findByRole('link', { name: 'Spend', current: 'page' })
    act(() => control.show('chat'))

    const chats = sockets.filter((one) => one.url.includes('/chat'))
    expect(chats).toHaveLength(1)
    expect(chats[0]?.closed).toBe(false)
  })

  /** Y-639: every Stop ends in `no_session`, which is a stopped agent and not
   *  a terminal that refused to attach. */
  it('draws a stopped session as a note and opens no terminal socket', async () => {
    daemon(looked(workspaces), looked({ workspace: 'landing', machine: 'macbook', reached: 'yes', status: { state: 'no_session' } }))
    const sockets: string[] = []
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: string) {
          sockets.push(url)
        }
        send() {}
        close() {}
      },
    )
    await open('landing', 'terminal')

    await screen.findByText('landing is stopped. Resume starts claude again.')
    expect(screen.getByRole('button', { name: 'Resume' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText(/has no terminal to attach to/)).toBeNull()
    expect(sockets).toEqual([])
  })

  /** Y-644: the page says which session and where, and not which multiplexer. */
  it('names the terminal by session and machine, with no tmux word', async () => {
    daemon()
    vi.stubGlobal(
      'WebSocket',
      class {
        send() {}
        close() {}
      },
    )
    await open('landing', 'terminal')

    // The page title names the session, so the status in the bar says only how it is going.
    expect(await screen.findByText('Connecting')).toBeTruthy()
    expect(document.querySelector('.session__terminal')?.textContent).not.toMatch(/tmux/i)
  })

  it('reattaches the chat when the URL names another thread', async () => {
    daemon()
    const sockets: { url: string; closed: boolean }[] = []
    vi.stubGlobal(
      'WebSocket',
      class {
        static OPEN = 1
        readyState = 0
        record: { url: string; closed: boolean }
        constructor(url: string) {
          this.record = { url, closed: false }
          sockets.push(this.record)
        }
        send() {}
        close() {
          this.record.closed = true
        }
      },
    )
    const control: { pick: (thread: string | undefined) => void } = { pick: () => {} }
    function Switch() {
      const [thread, setThread] = useState<string | undefined>('aaaaaaaa')
      useEffect(() => {
        control.pick = setThread
      }, [setThread])
      return <Workspace name="landing" thread={thread} view="chat" />
    }
    await renderInApp(<Switch />, new QueryClient({ defaultOptions: { queries: { retry: false } } }))

    await waitFor(() => expect(sockets.some((one) => one.url.includes('thread=aaaaaaaa'))).toBe(true))
    act(() => control.pick('bbbbbbbb'))

    await waitFor(() => expect(sockets.some((one) => one.url.includes('thread=bbbbbbbb'))).toBe(true))
    expect(sockets.find((one) => one.url.includes('thread=aaaaaaaa'))?.closed).toBe(true)
  })

  it('goes back to a blank chat when the URL drops the thread', async () => {
    daemon()
    const sockets: { url: string; closed: boolean }[] = []
    vi.stubGlobal(
      'WebSocket',
      class {
        static OPEN = 1
        readyState = 0
        record: { url: string; closed: boolean }
        constructor(url: string) {
          this.record = { url, closed: false }
          sockets.push(this.record)
        }
        send() {}
        close() {
          this.record.closed = true
        }
      },
    )
    const control: { pick: (thread: string | undefined) => void } = { pick: () => {} }
    function Switch() {
      const [thread, setThread] = useState<string | undefined>('aaaaaaaa')
      useEffect(() => {
        control.pick = setThread
      }, [setThread])
      return <Workspace name="landing" thread={thread} view="chat" />
    }
    await renderInApp(<Switch />, new QueryClient({ defaultOptions: { queries: { retry: false } } }))

    await waitFor(() => expect(sockets.some((one) => one.url.includes('thread=aaaaaaaa'))).toBe(true))
    const before = sockets.length
    act(() => control.pick(undefined))

    await waitFor(() => expect(sockets.length).toBeGreaterThan(before))
    expect(sockets.slice(before).every((one) => !one.url.includes('thread='))).toBe(true)
    expect(sockets.find((one) => one.url.includes('thread=aaaaaaaa'))?.closed).toBe(true)
  })
})

/** Y-638: the sweep is up to 30 s behind the create, so the 201 draws the page. */
describe('a workspace just created, before the sweep lists it', () => {
  const made = { name: 'fresh', machine: 'macbook', repo: '/Users/biswa/Github/fresh', startup: null }
  const seeded = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(keys.created('fresh'), made)
    return client
  }

  it('draws the session from the 201 and never says not found, even when the list polls again', async () => {
    daemon()
    const client = seeded()
    await renderInApp(<Workspace name="fresh" view="spend" />, client)

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('fresh')
    await act(() => client.invalidateQueries({ queryKey: keys.workspaces() }))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('fresh')
    expect(screen.queryByText(/No workspace is called/)).toBeNull()
  })

  it('prefers the listed entry once the sweep has it', async () => {
    daemon(looked([...workspaces, { loaded: 'yes', ...made, machine: 'pi' }]))
    await renderInApp(<Workspace name="fresh" view="spend" />, seeded())

    await waitFor(() =>
      expect(document.querySelector('.session__meta')?.textContent).toContain('pi ·'),
    )
  })
})

describe('the Chat tab with nothing in it', () => {
  it('draws one empty state, and no thread list in the page body', async () => {
    daemon()
    vi.stubGlobal(
      'WebSocket',
      class {
        static OPEN = 1
        readyState = 0
        onopen: (() => void) | null = null
        constructor() {
          queueMicrotask(() => {
            this.readyState = 1
            this.onopen?.()
          })
        }
        send() {}
        close() {}
      },
    )
    await open('landing', 'chat')
    await screen.findByRole('button', { name: 'Stop' })
    expect(await screen.findAllByText('Nothing asked yet')).toHaveLength(1)
    expect(screen.queryByText(/No threads yet/)).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Threads' })).toBeNull()
    expect(document.querySelector('.threads')).toBeNull()
  })
})

describe("the Terminal's History", () => {
  const history = () => screen.findByRole('button', { name: 'Show History' })

  it('reads the transcript when it opens, and not when the Terminal does', async () => {
    const asked = daemon()
    await open('landing', 'terminal')
    const show = await history()
    await new Promise((done) => setTimeout(done, 50))
    expect(asked.filter((one) => one.endsWith('/logs'))).toEqual([])

    fireEvent.click(show)
    await screen.findByText(/the last .* records/)
    expect(asked.filter((one) => one.endsWith('/logs'))).toEqual(['POST /api/workspaces/landing/logs'])
  })

  it('says what it holds, in one line, and has no link to its own view', async () => {
    daemon()
    await open('landing', 'terminal')
    fireEvent.click(await history())
    expect(
      await screen.findByText(
        'What the agent in this terminal said, read from its transcript on macbook. Chat turns are not here.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Take control' })).toBeNull()
  })

  it('is on the Terminal only', async () => {
    daemon()
    await open('landing', 'spend')
    await screen.findByRole('link', { name: 'Spend', current: 'page' })
    expect(screen.queryByRole('button', { name: 'Show History' })).toBeNull()
  })
})

describe("the Terminal's status", () => {
  it('sits in the bar with the tabs, short, and the phone has no fallback banner', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }))
    daemon()
    await open('landing', 'terminal')

    const status = await screen.findByRole('status')
    const bar = document.querySelector('.session__bar') as HTMLElement
    expect(bar.contains(status)).toBe(true)
    expect(status.textContent).toMatch(/^(Connecting|Reconnecting)/)
    expect(document.querySelector('.terminal > .terminal__status')).toBeNull()
    expect(screen.queryByText(/is the fallback/)).toBeNull()
  })
})

describe('what `/w/{name}` draws when there is no session behind it', () => {
  it('says no workspace carries the name, and points at the fleet', async () => {
    daemon()
    await open('nowhere')

    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe(
      'No workspace is called nowhere',
    )
    expect(screen.getByRole('link', { name: 'Fleet' }).getAttribute('href')).toBe('/fleet')
  })

  /** ADR-0020: only the bytes fix a file that will not load, so the one way
   *  out is the editor rather than a form over fields that were not read. */
  it('draws a file that will not load with the daemon words and a way to repair it', async () => {
    daemon()
    await open('price-table')

    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe(
      'price-table is not usable.',
    )
    expect(screen.getByText(/missing field 'machine' at line 7/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Repair the file' }).getAttribute('href')).toBe(
      '/w/price-table/repair',
    )
  })

  it('draws a workspace list that could not be read as its own failure', async () => {
    daemon({ looked: 'failed', age_seconds: 0, error: 'connection refused' })
    await open('landing')

    const said = await screen.findByRole('alert')
    expect(said.textContent).toContain('The workspaces could not be read')
    fireEvent.click(within(said).getByRole('button', { name: 'Details' }))
    expect(said.textContent).toContain('connection refused')
    expect(said.textContent).not.toContain('off the tailnet')
  })
})
