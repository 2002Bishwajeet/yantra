/**
 * The route wiring, mounted the way `main.tsx` mounts it. Y-161, Y-162.
 *
 * What is asserted here is ours — which component a path draws, what a link
 * goes to, and that `/w/{name}` reads the list before it opens a socket.
 * Matching, history and the modified-click rule are TanStack Router's and are
 * not re-tested here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { Listed, Looked, Machine, Workspace } from './api'
import App from './App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
})

/** `DataTable` asks for a width and xterm.js asks for the device pixel ratio,
 *  and jsdom has no `matchMedia` for either — `dashboard.test.tsx` and
 *  `terminal.test.tsx` each record their half.
 *
 *  Two query shapes now: `DataTable`'s `(width < 48rem)` and the workspace
 *  tabs' `(min-width: 768px)`, both answered against a 1280 px window. */
beforeEach(() => {
  // TanStack Router scrolls on navigation and jsdom implements no `scrollTo`.
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: /rem/.test(query)
      ? 1280 < Number(/([\d.]+)rem/.exec(query)?.[1]) * 16
      : Number(/([\d.]+)px/.exec(query)?.[1]) <= 1280,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
})

const laptop: Machine = {
  name: 'cachyos-g14',
  dns_name: 'cachyos-g14.<tailnet>.ts.net.',
  os: 'linux',
  online: true,
  expired: false,
  last_seen: null,
  heartbeat: null,
}

const yantra: Workspace = {
  name: 'yantra',
  machine: 'cachyos-g14',
  repo: '/home/<user>/Github/homelab/yantra',
  startup: null,
}

function fleet(overrides: Record<string, Looked<unknown> | number> = {}) {
  const answers: Record<string, Looked<unknown> | number> = {
    '/api/machines': { looked: 'ok', age_seconds: 1, data: [laptop] },
    '/api/workspaces': {
      looked: 'ok',
      age_seconds: 1,
      data: [{ loaded: 'yes', ...yantra } satisfies Listed],
    },
    '/api/sessions': { looked: 'never' },
    '/api/workspaces/yantra/status': 404,
    ...overrides,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      const answer = answers[path]
      return typeof answer === 'number'
        ? Promise.resolve({ ok: false, status: answer })
        : Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(answer),
          })
    }),
  )
}

/** A socket that connects to nothing — what crosses one is
 *  `terminal.test.tsx`'s subject against a real server, and what this file
 *  needs to know is only which URL was asked for. */
function quietSocket(): string[] {
  const asked: string[] = []
  vi.stubGlobal(
    'WebSocket',
    class {
      static OPEN = 1
      readyState = 0
      binaryType = ''
      constructor(url: string) {
        asked.push(url)
      }
      send() {}
      close() {}
    },
  )
  return asked
}

describe('a URL typed into the bar', () => {
  it('lands on the machine rather than the fleet', async () => {
    fleet()
    history.pushState(null, '', '/m/cachyos-g14')

    render(<App />)

    expect(await screen.findByText('linux')).toBeTruthy()
    // The fleet's own sections are what would have been drawn before Y-161.
    expect(screen.queryByText('New workspace')).toBeNull()
  })

  it('opens the workspace terminal, and asks for that workspace', async () => {
    fleet()
    const asked = quietSocket()
    history.pushState(null, '', '/w/yantra')

    render(<App />)

    expect(await screen.findByText('Terminal — yantra')).toBeTruthy()
    expect(asked).toEqual(['ws://localhost:3000/api/workspaces/yantra/terminal'])
  })

  /** **Y-179**, and the address ADR-0022 widened: no workspace is read, and
   *  nothing on the path is looked up before the socket. */
  it('opens a session terminal on the machine and the session the path names', async () => {
    fleet()
    const asked = quietSocket()
    history.pushState(null, '', '/m/cachyos-g14/s/scratch')

    render(<App />)

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'scratch on cachyos-g14',
      }),
    ).toBeTruthy()
    expect(asked).toEqual([
      'ws://localhost:3000/api/machines/cachyos-g14/sessions/scratch/terminal',
    ])
    expect(document.title).toBe('scratch on cachyos-g14 · Yantra')
  })

  /** The daemon falls every unknown path back to `index.html`, so this arrives
   *  as a page and drawing the fleet for it would make the address bar a lie.
   *  `/settings` used to be the path here; D3 §3 routes it, so this asks for one
   *  that never will be. */
  it('says nothing is at a path nothing routes', async () => {
    fleet()
    history.pushState(null, '', '/no-such-page')

    render(<App />)

    expect(await screen.findByText(/Nothing is at/)).toBeTruthy()
    expect(screen.queryByText('Workspaces')).toBeNull()
  })

  it('says a workspace it has read the list for is not there, and opens no socket', async () => {
    fleet()
    const asked = quietSocket()
    history.pushState(null, '', '/w/gone')

    render(<App />)

    expect(await screen.findByText('No workspace is called gone.')).toBeTruthy()
    expect(asked).toEqual([])
  })
})

/** D3 §3.1: `/machines` compares, so the page about one machine draws none —
 *  and drops no fact the comparison carried on its way to being a subject. */
describe('one machine, as a subject', () => {
  const asleep: Machine = {
    ...laptop,
    online: false,
    expired: true,
    // No zone, so `Stamp` prints it as it arrived — D3 §5.7.
    last_seen: '4d ago',
    heartbeat: {
      age_seconds: 4000,
      arch: 'x86_64',
      labels: [],
      free_ram_mb: 9000,
      free_disk_mb: 100,
      cpu_busy_pct: 15,
      power: 'ac',
    },
  }

  async function open(one: Machine) {
    fleet({ '/api/machines': { looked: 'ok', age_seconds: 1, data: [one] } })
    history.pushState(null, '', '/m/cachyos-g14')
    render(<App />)
    await screen.findByText('linux')
  }

  /** The machine's own block, which is the first `dl` on the page. Scoped
   *  rather than searched for: the workspaces table repeats the same beat in
   *  its MACHINE column, so a page-wide match proves nothing about this block. */
  const about = () => document.querySelector('dl') as HTMLElement

  const terms = () =>
    [...about().querySelectorAll('dt')].map((one) => one.textContent)

  it('keeps every fact the machines table carried', async () => {
    await open(asleep)

    // The name was the MACHINE column, linking to the page you are on; here it
    // is the heading.
    expect(
      screen.getByRole('heading', { level: 1, name: 'cachyos-g14' }),
    ).toBeTruthy()
    for (const fact of [
      'linux',
      'offline, key expired',
      'asleep or off',
      'beat 1h',
      '4d ago',
    ]) {
      expect(about().textContent).toContain(fact)
    }
  })

  it('draws them as terms rather than as a row in a table', async () => {
    await open(asleep)

    expect(terms()).toEqual(
      expect.arrayContaining(['OS', 'STATUS', 'HEARTBEAT', 'LAST SEEN']),
    )
    // These three headers are `machineColumns` and nothing else on the page, so
    // one of them is the comparison table still being drawn here.
    for (const header of ['OS', 'HEARTBEAT', 'LAST SEEN']) {
      expect(screen.queryByRole('columnheader', { name: header })).toBeNull()
    }
  })

  it('says nothing about last seen while the machine is online, as the blank cell did', async () => {
    await open(laptop)

    expect(terms()).not.toContain('LAST SEEN')
    expect(about().textContent).toContain('never heard from')
  })

  it('still says the tailnet has no machine of that name', async () => {
    fleet({ '/api/machines': { looked: 'ok', age_seconds: 1, data: [] } })
    history.pushState(null, '', '/m/cachyos-g14')

    render(<App />)

    expect(
      await screen.findByText('This tailnet has no machine called cachyos-g14.'),
    ).toBeTruthy()
  })

  /** **Y-179.** The verb Y-320 drew disabled now goes somewhere, and it opens
   *  nothing on the way: a machine's session list holds one ssh per row and D5
   *  §3.5's rule is that nothing attaches until a person asks. */
  it('reaches a session terminal from the row, and opens no socket before the tap', async () => {
    fleet({
      '/api/sessions': {
        looked: 'ok',
        age_seconds: 1,
        data: [
          {
            machine: 'cachyos-g14',
            reached: 'yes',
            sessions: [
              {
                name: 'scratch',
                windows: 2,
                attached: 0,
                created: 'Thu Jul 30 13:02:31 2026',
              },
            ],
          },
        ],
      },
    })
    const asked = quietSocket()
    history.pushState(null, '', '/m/cachyos-g14')
    render(<App />)

    const open = await screen.findByRole('link', {
      name: 'Terminal for scratch on cachyos-g14',
    })
    expect(asked).toEqual([])

    fireEvent.click(open)

    await waitFor(() =>
      expect(location.pathname).toBe('/m/cachyos-g14/s/scratch'),
    )
    expect(await screen.findByText('Terminal — scratch on cachyos-g14')).toBeTruthy()
    expect(asked).toEqual([
      'ws://localhost:3000/api/machines/cachyos-g14/sessions/scratch/terminal',
    ])
  })
})

/** D3 §3 and §5.2: three nav items, one `h1` per route, `h2` for a group, and a
 *  `<title>` that names where you are rather than what the app is. */
describe('the outline', () => {
  const outline = () =>
    [...document.querySelectorAll('h1, h2')].map(
      (heading) => `${heading.tagName} ${heading.textContent}`,
    )

  it('gives every route one h1, and groups an h2 under it', async () => {
    fleet()
    render(<App />)

    await screen.findByRole('heading', { level: 1, name: 'Fleet' })
    const headings = outline()
    expect(headings.filter((one) => one.startsWith('H1 '))).toEqual(['H1 Fleet'])
    expect(headings.filter((one) => one.startsWith('H2 ')).length).toBeGreaterThan(0)
    // The wordmark was the page's only heading before Y-187.
    expect(headings).not.toContain('H1 Yantra')
  })

  it('names the route in the title, front first', async () => {
    fleet()
    history.pushState(null, '', '/m/cachyos-g14')

    render(<App />)

    await screen.findByText('linux')
    expect(document.title).toBe('cachyos-g14 · Yantra')
  })

  it('reaches fleet, machines and usage from anywhere', async () => {
    fleet()
    history.pushState(null, '', '/m/cachyos-g14')
    render(<App />)

    const nav = within(await screen.findByRole('navigation'))
    for (const label of ['fleet', 'machines', 'usage']) {
      expect(nav.getByRole('link', { name: label })).toBeTruthy()
    }

    fireEvent.click(nav.getByRole('link', { name: 'machines' }))
    await waitFor(() => expect(location.pathname).toBe('/machines'))
    expect(await screen.findByText('Unclaimed sessions')).toBeTruthy()
    expect(document.title).toBe('Machines · Yantra')

    // `/usage` is split (Y-194), so the heading arrives with the chunk rather
    // than with the path.
    fireEvent.click(nav.getByRole('link', { name: 'usage' }))
    await waitFor(() => expect(location.pathname).toBe('/usage'))
    await screen.findByRole('heading', { level: 1, name: 'Usage' })
    expect(outline().filter((one) => one.startsWith('H1 '))).toEqual([
      'H1 Usage',
    ])
  })

  /** D3 §3.1: `/machines` compares and `/m/{name}` is a subject, so the three
   *  groups that moved must not still be drawn where they were. */
  it('takes machines, readiness and sessions off the work page', async () => {
    fleet()
    render(<App />)

    await screen.findByRole('heading', { level: 1, name: 'Fleet' })
    for (const gone of ['Machines', 'Readiness', 'Unclaimed sessions']) {
      expect(screen.queryByRole('heading', { name: gone })).toBeNull()
    }
  })
})

describe('moving between them', () => {
  it('follows a machine name and comes back with the browser', async () => {
    fleet()
    render(<App />)

    // By role, not by position. Y-190 makes the work rows wait for the read
    // that bands them, so the machine picker's `option` of the same name now
    // paints first and `findAllByText(...)[0]` picked it.
    fireEvent.click(await screen.findByRole('link', { name: 'cachyos-g14' }))

    await waitFor(() => expect(location.pathname).toBe('/m/cachyos-g14'))
    expect(screen.queryByText('New workspace')).toBeNull()

    history.back()

    await waitFor(() => expect(location.pathname).toBe('/'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Fleet' })).toBeTruthy()
  })

  it('opens the terminal route from the overflow in a workspace row', async () => {
    fleet({
      '/api/sessions': {
        looked: 'ok',
        age_seconds: 1,
        data: [
          {
            machine: 'cachyos-g14',
            reached: 'yes',
            sessions: [
              { name: 'yantra', windows: 1, attached: 0, created: 'today' },
            ],
          },
        ],
      },
    })
    quietSocket()
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'More for yantra' }))
    fireEvent.click(await screen.findByText('Open terminal'))

    await waitFor(() => expect(location.pathname).toBe('/w/yantra'))
    expect(await screen.findByText('Terminal — yantra')).toBeTruthy()
  })
})
