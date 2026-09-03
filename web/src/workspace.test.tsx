/**
 * `/w/{name}`'s three tabs and what the URL carries — D5 §3, Y-308 — and the
 * height its terminal is given, Y-313.
 *
 * **What the socket does is `terminal.test.tsx`'s subject.** What this file
 * asserts is which tab is drawn, and that opening one is the only thing that
 * opens a socket at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { Listed } from './api'
import App from './App'
import { Terminal } from './components/Terminal'
import { logs } from './contract.gen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
})

const yantra: Listed = {
  loaded: 'yes',
  name: 'yantra',
  machine: 'cachyos-g14',
  repo: '/home/<user>/Github/homelab/yantra',
  startup: null,
}

/** The workspace list, which this page reads before it opens anything, and one
 *  window of the transcript for the tab that reads on open. Every other path
 *  answers `never`, so a reading added to the page later cannot make this file
 *  fail for a reason that is not its subject. */
function daemon() {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      if (path === '/api/viewing') {
        return Promise.resolve({ ok: true, status: 204 })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            path === '/api/workspaces'
              ? { looked: 'ok', age_seconds: 1, data: [yantra] }
              : path === '/api/workspaces/yantra/logs'
                ? logs
                : { looked: 'never' },
          ),
      })
    }),
  )
}

/** jsdom has no `matchMedia`, so the window's width is supplied — and the query
 *  is answered rather than a fixed boolean, so the breakpoint stays the page's
 *  to choose. Returns every listener anyone registered on it, which is what the
 *  resize assertion needs. */
function viewport(width: number) {
  const watched: string[] = []
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: /rem/.test(query)
      ? width < Number(/([\d.]+)rem/.exec(query)?.[1]) * 16
      : Number(/([\d.]+)px/.exec(query)?.[1]) <= width,
    addEventListener: () => watched.push(query),
    removeEventListener: () => {},
    addListener: () => watched.push(query),
    removeListener: () => {},
  }))
  return watched
}

/** A socket that connects to nothing: this file needs to know only whether one
 *  was opened, which is what mounting a tab costs (D5 §3.5). */
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

const PHONE = 390
const LAPTOP = 1280

beforeEach(() => {
  // TanStack Router scrolls on navigation and jsdom implements no `scrollTo`.
  vi.stubGlobal('scrollTo', () => {})
})

function open(url: string, width: number) {
  daemon()
  const watched = viewport(width)
  const asked = quietSocket()
  history.pushState(null, '', url)
  render(<App />)
  return { watched, asked }
}

const tabs = () =>
  screen.getAllByRole('link').flatMap((link) => {
    const label = link.textContent ?? ''
    return ['terminal', 'transcript', 'spend'].includes(label) ? [label] : []
  })

const openTab = () =>
  screen.queryByRole('link', { current: 'page' })?.textContent

describe('the three tabs of one workspace', () => {
  it('names all three, whichever one is open', async () => {
    open('/w/yantra', LAPTOP)

    expect(await screen.findByText('Terminal — yantra')).toBeTruthy()
    expect(tabs()).toEqual(['terminal', 'transcript', 'spend'])
  })

  /** D5 §3.3 and D3 §11.1: a laptop lands in the pane, and the URL says
   *  nothing — so the link copied from it still opens the transcript on a
   *  phone. */
  it('lands a wide window in the terminal, with nothing in the URL', async () => {
    const { asked } = open('/w/yantra', LAPTOP)

    expect(await screen.findByText('Terminal — yantra')).toBeTruthy()
    expect(openTab()).toBe('terminal')
    expect(location.search).toBe('')
    expect(asked).toEqual(['ws://localhost:3000/api/workspaces/yantra/terminal'])
  })

  /** D3 §11.2: 390 px gives about 45 columns of a TUI that wants 80, so the
   *  phone lands on what happened rather than on what is happening. */
  it('lands a narrow window in the transcript, and opens no socket', async () => {
    const { asked } = open('/w/yantra', PHONE)

    // The transcript's own reads are `transcript.test.tsx`'s subject; what
    // matters here is that the tab drew and the pane did not.
    expect(await screen.findByText('run the tests')).toBeTruthy()
    expect(openTab()).toBe('transcript')
    expect(screen.queryByText('Terminal — yantra')).toBeNull()
    expect(asked).toEqual([])
  })

  it('lets an explicit view beat the width, both ways round', async () => {
    open('/w/yantra?view=terminal', PHONE)
    expect(await screen.findByText('Terminal — yantra')).toBeTruthy()

    cleanup()
    vi.unstubAllGlobals()
    vi.stubGlobal('scrollTo', () => {})

    open('/w/yantra?view=spend', LAPTOP)
    expect(await screen.findByText('Spend is not built yet.')).toBeTruthy()
    expect(screen.queryByText('Terminal — yantra')).toBeNull()
  })

  /** D5 §3.3: the workspace is real and the page can draw, so a typo is
   *  ignored rather than turned into a page that says nothing is here. */
  it('falls an unknown view back to the width rather than 404ing', async () => {
    open('/w/yantra?view=nonsense', LAPTOP)

    expect(await screen.findByText('Terminal — yantra')).toBeTruthy()
    expect(openTab()).toBe('terminal')
    expect(screen.queryByText(/Nothing is at/)).toBeNull()
  })

  /** D5 §3.3's second half. A tab that moved under a resize would move under a
   *  phone rotating, so the page must not be listening at all — the width is
   *  read once, and the listeners prove it. */
  it('keeps the tab it opened on when the window is resized', async () => {
    const { watched } = open('/w/yantra', LAPTOP)
    expect(await screen.findByText('Terminal — yantra')).toBeTruthy()

    viewport(PHONE)
    fireEvent(window, new Event('resize'))

    expect(watched).not.toContain('(min-width: 768px)')
    expect(screen.getByText('Terminal — yantra')).toBeTruthy()
    expect(screen.queryByText('run the tests')).toBeNull()
  })

  /** D5 §3.4: three tabs of one page are one place. Back walking them is how a
   *  phone traps someone tapping it to leave a page they opened once. */
  it('replaces the history entry, so Back leaves the page', async () => {
    daemon()
    viewport(LAPTOP)
    quietSocket()
    history.pushState(null, '', '/')
    history.pushState(null, '', '/w/yantra')
    render(<App />)
    await screen.findByText('Terminal — yantra')

    fireEvent.click(screen.getByRole('link', { name: 'spend' }))

    await waitFor(() => expect(location.search).toBe('?view=spend'))
    expect(await screen.findByText('Spend is not built yet.')).toBeTruthy()

    history.back()

    await waitFor(() => expect(location.pathname).toBe('/'))
  })
})

/** Y-313. The prop exists so D3 §4.5's twelve-row trust prompt has somewhere to
 *  come from; this page is the caller that wants the default. */
describe('the height of the terminal', () => {
  const pane = () => document.querySelector('.xterm')?.parentElement

  it('is 60vh on a page that passes none', async () => {
    open('/w/yantra', LAPTOP)

    await screen.findByText('Terminal — yantra')
    expect(pane()?.style.height).toBe('60vh')
  })

  it('is whatever a caller asks for', () => {
    viewport(LAPTOP)
    quietSocket()

    render(<Terminal name="yantra" height="12rem" onClose={() => {}} />)

    expect(pane()?.style.height).toBe('12rem')
  })
})
