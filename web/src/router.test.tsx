/**
 * The M14 route tree (Y-345), mounted the way `main.tsx` mounts it.
 *
 * What is asserted here is ours — which screen a path draws, what the search
 * params keep, which reads a route warms, and what an unknown path gets.
 * Matching, history and code splitting are TanStack Router's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import App from './App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
})

/** Every read answers `never`: a valid envelope, and nothing to draw. */
function quiet() {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      if (init?.method !== 'POST') asked.push(path)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ looked: 'never' }),
      })
    }),
  )
  return asked
}

beforeEach(() => {
  // TanStack Router scrolls on navigation and jsdom implements no `scrollTo`.
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width: 1240px'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    // xterm.js still asks for the legacy pair on the device-pixel-ratio query.
    addListener: () => {},
    removeListener: () => {},
  }))
})

async function open(path: string) {
  quiet()
  history.pushState(null, '', path)
  render(<App />)
}

const h1 = (name: string) => screen.findByRole('heading', { level: 1, name })

describe('every path draws its screen and names it in the title', () => {
  it.each([
    ['/', 'Dashboard', 'Dashboard · Yantra'],
    ['/fleet', 'Fleet', 'Fleet · Yantra'],
    ['/machines', 'Machines', 'Machines · Yantra'],
    ['/m/pi-5', 'pi-5', 'pi-5 · Yantra'],
    ['/m/pi-5/s/scratch', 'scratch on pi-5', 'scratch on pi-5 · Yantra'],
    ['/usage', 'Usage', 'Usage · Yantra'],
    ['/w/landing', 'landing', 'landing · Yantra'],
    ['/w/landing/repair', 'Repair landing', 'Repair landing · Yantra'],
    ['/new', 'New session', 'New session · Yantra'],
    ['/settings', 'Settings', 'Settings · Yantra'],
    ['/settings/about', 'Settings', 'About · Yantra'],
  ])('%s', async (path, heading, title) => {
    await open(path)
    expect(await h1(heading)).toBeTruthy()
    await waitFor(() => expect(document.title).toBe(title))
  })

  /** The daemon falls every unknown path back to `index.html`, so this arrives
   *  as a page and drawing the dashboard for it would make the address bar a
   *  lie. */
  it('says nothing is at a path nothing routes', async () => {
    await open('/no-such-page')
    expect(await screen.findByText(/Nothing is at/)).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: 'Dashboard' })).toBeNull()
  })
})

describe('the search params', () => {
  it('keeps a known view on /w/{name} and drops an unknown one', async () => {
    await open('/w/landing?view=chat')
    await h1('landing')
    expect(location.search).toBe('?view=chat')

    cleanup()
    await open('/w/landing?view=bogus')
    await h1('landing')
    await waitFor(() => expect(location.search).toBe(''))
  })

  it('keeps a step of one to four on /new and drops the rest', async () => {
    await open('/new?step=3')
    await h1('New session')
    expect(location.search).toBe('?step=3')

    cleanup()
    await open('/new?step=9')
    await h1('New session')
    await waitFor(() => expect(location.search).toBe(''))
  })
})

describe('a route warms its reads', () => {
  it('asks for the four dashboard classes on /', async () => {
    const asked = quiet()
    render(<App />)
    await h1('Dashboard')
    await waitFor(() =>
      expect(asked).toEqual(
        expect.arrayContaining([
          '/api/workspaces',
          '/api/machines',
          '/api/sessions',
          '/api/attention',
        ]),
      ),
    )
  })

  it('asks for the one machine on /m/{machine}', async () => {
    const asked = quiet()
    history.pushState(null, '', '/m/pi-5')
    render(<App />)
    await h1('pi-5')
    await waitFor(() => expect(asked).toContain('/api/machines/pi-5/readiness'))
  })
})
