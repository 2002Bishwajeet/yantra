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
 *  `terminal.test.tsx` each record their half. */
beforeEach(() => {
  // TanStack Router scrolls on navigation and jsdom implements no `scrollTo`.
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: 1280 < Number(/([\d.]+)rem/.exec(query)?.[1]) * 16,
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

  /** The daemon falls every unknown path back to `index.html`, so this arrives
   *  as a page and drawing the fleet for it would make the address bar a lie. */
  it('says nothing is at a path nothing routes', async () => {
    fleet()
    history.pushState(null, '', '/settings')

    render(<App />)

    expect(await screen.findByText(/Nothing is at/)).toBeTruthy()
    expect(screen.queryByText('Machines')).toBeNull()
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

describe('moving between them', () => {
  it('follows a machine name and comes back with the browser', async () => {
    fleet()
    render(<App />)

    // Named twice on the fleet: its own row, and the workspace that runs there.
    fireEvent.click((await screen.findAllByText('cachyos-g14'))[0]!)

    await waitFor(() => expect(location.pathname).toBe('/m/cachyos-g14'))
    expect(screen.queryByText('New workspace')).toBeNull()

    history.back()

    await waitFor(() => expect(location.pathname).toBe('/'))
    expect(await screen.findByText('New workspace')).toBeTruthy()
  })

  it('opens the terminal route from the button in a workspace row', async () => {
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

    fireEvent.click(await screen.findByText('Open terminal'))

    await waitFor(() => expect(location.pathname).toBe('/w/yantra'))
    expect(await screen.findByText('Terminal — yantra')).toBeTruthy()
  })
})
