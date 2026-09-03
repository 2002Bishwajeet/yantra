/**
 * `/w/{name}` against a machine that cannot be reached — D5 §7, Y-312.
 *
 * **The tabs stay, and each one says what it could not reach.** Only the open
 * tab is mounted (§3.5), so a reader sees one refusal at a time — and each one
 * names the machine, so the first one already says where the fault is. A
 * page-level banner would say the same thing once instead of three times and
 * would cost a spend figure the reader had already read.
 *
 * **The terminal tab's refusal is `terminal.test.tsx`'s**, where a real socket
 * refuses a real connection. This file drives the two tabs that refuse over
 * `fetch`, and asserts what the page keeps in both cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import type { Listed } from './api'
import App from './App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
})

beforeEach(() => {
  // TanStack Router scrolls on navigation and jsdom implements no `scrollTo`.
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
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
})

const MACHINE = 'cachyos-g14'

const yantra: Listed = {
  loaded: 'yes',
  name: 'yantra',
  machine: MACHINE,
  repo: '/home/<user>/Github/homelab/yantra',
  startup: null,
}

/** What the daemon says when the machine behind a workspace is asleep or off
 *  the tailnet: a 503 carrying the whole `source()` chain. */
const ASLEEP = `ssh: connect to host ${MACHINE} port 22: No route to host`

/** The workspace list answers, because the list is the daemon's own and it
 *  loaded. Every read that has to reach the machine refuses. */
function daemon() {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: { method?: string }) => {
      if (path === '/api/viewing') {
        return Promise.resolve({ ok: true, status: 204 })
      }
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve(ASLEEP),
          json: () => Promise.reject(new Error('not json')),
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            path === '/api/workspaces'
              ? { looked: 'ok', age_seconds: 1, data: [yantra] }
              : { looked: 'never' },
          ),
      })
    }),
  )
}

function open(view: string) {
  daemon()
  history.pushState(null, '', `/w/yantra?view=${view}`)
  render(<App />)
}

const tabs = () =>
  screen
    .getAllByRole('link')
    .map((link) => link.textContent ?? '')
    .filter((label) => ['terminal', 'transcript', 'spend'].includes(label))

/** The machine, wherever it is named: `/m/{machine}` is where its heartbeat,
 *  its readiness and its last-seen age are, and that is the next thing anyone
 *  wants once a tab has said it could not be reached. */
const machineLinks = () =>
  screen
    .getAllByRole('link', { name: MACHINE })
    .map((link) => link.getAttribute('href'))

describe('each tab draws its own refusal', () => {
  it('names the machine on the transcript tab, and links to it', async () => {
    open('transcript')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The transcript could not be read.')
    expect(alert.textContent).toContain(MACHINE)
    expect(alert.textContent).toContain('No route to host')
    expect(
      within(alert).getByRole('link', { name: MACHINE }).getAttribute('href'),
    ).toBe(`/m/${MACHINE}`)
  })

  it('names the machine on the spend tab, and links to it', async () => {
    open('spend')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The machine could not be asked')
    expect(alert.textContent).toContain(MACHINE)
    expect(alert.textContent).toContain('No route to host')
    expect(
      within(alert).getByRole('link', { name: MACHINE }).getAttribute('href'),
    ).toBe(`/m/${MACHINE}`)
  })

  /** One refusal at a time, because only the open tab is mounted. Two of them
   *  on screen together would be the banner this row exists to prevent, drawn
   *  the long way round. */
  it('replaces one refusal with the next when the tab changes', async () => {
    open('transcript')
    await screen.findByText('The transcript could not be read.')

    fireEvent.click(screen.getByRole('link', { name: 'spend' }))

    await screen.findByText(/The machine could not be asked/)
    expect(screen.queryByText('The transcript could not be read.')).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })
})

describe('no page-level banner replaces the tabs', () => {
  it('keeps all three tabs and the heading while the transcript refuses', async () => {
    open('transcript')
    await screen.findByRole('alert')

    expect(tabs()).toEqual(['terminal', 'transcript', 'spend'])
    expect(screen.getByRole('heading', { level: 1, name: 'yantra' })).toBeTruthy()
  })

  it('keeps all three tabs and the heading while spend refuses', async () => {
    open('spend')
    await screen.findByRole('alert')

    expect(tabs()).toEqual(['terminal', 'transcript', 'spend'])
    expect(screen.getByRole('heading', { level: 1, name: 'yantra' })).toBeTruthy()
  })

  /** The page's own `on {machine}` line is above the tab bar and is a link, and
   *  the tab's refusal names the machine again. Neither is the other's excuse:
   *  a reader who lands straight on the failing tab must see both. */
  it('leaves the machine a link above the tabs as well as inside the refusal', async () => {
    open('spend')
    await screen.findByRole('alert')

    expect(machineLinks()).toEqual([`/m/${MACHINE}`, `/m/${MACHINE}`])
  })

  /** R-23's own alert, and it is `Unreachable`'s — the one banner the dashboard
   *  does draw is for a daemon that cannot be reached at all, which is a
   *  different failure from a machine that cannot. */
  it('draws no whole-page alert about the connection', async () => {
    open('transcript')
    await screen.findByRole('alert')

    expect(screen.queryByText(/Nothing here can be reached/)).toBeNull()
    expect(screen.queryByText(/is not usable/)).toBeNull()
  })
})
