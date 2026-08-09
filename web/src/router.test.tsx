/**
 * The router, against the real History API jsdom implements. Y-161.
 *
 * Every navigation here goes through the same `<a href>` a person taps, and the
 * assertions are on `location.pathname` and on what is drawn — which together
 * are the whole of what "this URL reloads into the same view" means.
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
import { match } from './router'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
})

/** `DataTable` asks for a width and xterm.js asks for the device pixel ratio,
 *  and jsdom has no `matchMedia` for either — `dashboard.test.tsx` and
 *  `terminal.test.tsx` each record their half. */
beforeEach(() =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: 1280 < Number(/([\d.]+)rem/.exec(query)?.[1]) * 16,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })),
)

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

describe('what a path means', () => {
  it('reads the three routes and refuses everything else', () => {
    expect(match('/')).toEqual({ at: 'fleet' })
    expect(match('/m/cachyos-g14')).toEqual({
      at: 'machine',
      machine: 'cachyos-g14',
    })
    expect(match('/w/yantra')).toEqual({ at: 'workspace', name: 'yantra' })
    // Trailing slashes are the same path, not a fourth one.
    expect(match('/m/cachyos-g14/')).toEqual({
      at: 'machine',
      machine: 'cachyos-g14',
    })
    for (const path of ['/settings', '/m', '/m/', '/w/a/b', '/launch']) {
      expect(match(path)).toEqual({ at: 'nowhere', path })
    }
  })

  /** A name reaches the URL encoded, so it has to come back out — and a hand
   *  typed `%zz` is not a name at all rather than a crash. */
  it('decodes a name, and treats one that will not decode as no route', () => {
    expect(match('/w/my%20site')).toEqual({ at: 'workspace', name: 'my site' })
    expect(match('/w/%zz')).toEqual({ at: 'nowhere', path: '/w/%zz' })
  })
})

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
    expect(asked).toEqual([
      'ws://localhost:3000/api/workspaces/yantra/terminal',
    ])
  })

  /** The daemon falls every unknown path back to `index.html`, so this arrives
   *  as a page and drawing the fleet for it would make the address bar a lie. */
  it('says nothing is at a path nothing routes', async () => {
    fleet()
    history.pushState(null, '', '/settings')

    render(<App />)

    expect(await screen.findByText('Nothing is at /settings.')).toBeTruthy()
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

    fireEvent.click((await screen.findAllByText('cachyos-g14'))[0]!)

    expect(location.pathname).toBe('/m/cachyos-g14')
    await waitFor(() => expect(screen.queryByText('New workspace')).toBeNull())

    history.back()

    await waitFor(() => expect(location.pathname).toBe('/'))
    expect(await screen.findByText('New workspace')).toBeTruthy()
  })

  /** A modified click is the browser's — a new tab is a thing people do to a
   *  dashboard, and taking it over would break it silently. */
  it('leaves a middle or modified click to the browser', async () => {
    fleet()
    render(<App />)

    // Named twice on the fleet: its own row, and the workspace that runs there.
    const link = (await screen.findAllByText('cachyos-g14'))[0]!
    fireEvent.click(link, { metaKey: true })

    expect(location.pathname).toBe('/')
  })
})
