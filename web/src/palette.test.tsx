/**
 * The palette, mounted the way the header mounts it. Y-196.
 *
 * D3 §3.2 gives it one job — it finds workspaces, machines and routes, and it
 * runs no verb. The last test in this file is that rule: every entry the palette
 * offers is clicked, and the daemon is asked for nothing but readings.
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

// The same three stubs `router.test.tsx` needs, and for the same reasons:
// jsdom implements no `scrollTo`, and `DataTable` and xterm.js both ask
// `matchMedia`.
beforeEach(() => {
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: 1280 < Number(/([\d.]+)rem/.exec(query)?.[1]) * 16,
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

/** Returns the method of every request that was not a plain read, so a verb
 *  reaching the daemon from here is a failure with a name. */
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
  const wrote: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      // The shell's presence beacon is not the palette's doing (D3 §13), and
      // every route under test carries it.
      if (method !== 'GET' && path !== '/api/viewing') {
        wrote.push(`${method} ${path}`)
      }
      // The palette navigates, so pages this file never asserts on are drawn
      // anyway — and a reading nobody stubbed is one that has not happened.
      const answer = answers[path] ?? { looked: 'never' }
      return typeof answer === 'number'
        ? Promise.resolve({ ok: false, status: answer })
        : Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(answer),
          })
    }),
  )
  return wrote
}

const shortcut = () => fireEvent.keyDown(document, { key: 'k', metaKey: true })

async function opened() {
  shortcut()
  return within(await screen.findByRole('dialog'))
}

/** Only the entries, so a group's heading is not one of them — `Machines` is
 *  both a heading and a route, and they are told apart by their role. */
const entries = () =>
  within(screen.getByRole('dialog'))
    .getAllByRole('option')
    .map((one) => one.textContent)

describe('opening it', () => {
  it('opens on the shortcut, on either modifier', async () => {
    fleet()
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })

    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(await screen.findByRole('dialog')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  /** D3 §10: the phone is the constraint and it has no ⌘K, so the header
   *  carries a control that can be tapped. */
  it('opens from the header without a keyboard', async () => {
    fleet()
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /Search/ }))

    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('closes on Escape', async () => {
    fleet()
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })

    shortcut()
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('what it finds', () => {
  it('offers the workspaces, the machines and every route', async () => {
    fleet()
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })

    await opened()
    expect(entries()).toEqual([
      'yantra',
      'cachyos-g14',
      'Fleet',
      'Machines',
      'New workspace',
      'Settings',
      'Usage',
    ])
  })

  it('goes to the workspace', async () => {
    fleet()
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })

    const palette = await opened()
    fireEvent.click(palette.getByRole('option', { name: 'yantra' }))

    await waitFor(() => expect(location.pathname).toBe('/w/yantra'))
  })

  it('goes to the machine', async () => {
    fleet()
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })

    const palette = await opened()
    fireEvent.click(palette.getByRole('option', { name: 'cachyos-g14' }))

    await waitFor(() => expect(location.pathname).toBe('/m/cachyos-g14'))
  })

  it('goes to the route', async () => {
    fleet()
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })

    const palette = await opened()
    fireEvent.click(palette.getByRole('option', { name: 'Machines' }))

    await waitFor(() => expect(location.pathname).toBe('/machines'))
  })

  /** The narrowing is Base UI's and is not re-tested here; what this asks is
   *  that the entries are filterable at all, since the palette is how you reach
   *  a fleet no page lists. */
  it('narrows to what was typed', async () => {
    fleet()
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })

    const palette = await opened()
    fireEvent.change(palette.getByRole('combobox'), {
      target: { value: 'yan' },
    })

    await waitFor(() => expect(entries()).toEqual(['yantra']))
  })
})

/** D3 §3.2: *it runs no verbs*. Keeping them out is what §4.7 depends on — a
 *  delete is never two keystrokes from anywhere. */
describe('the verbs it does not run', () => {
  it('writes nothing, whichever entry is chosen', async () => {
    const wrote = fleet()
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })

    for (const name of ['yantra', 'cachyos-g14', 'Fleet', 'Machines', 'Usage']) {
      const palette = await opened()
      fireEvent.click(palette.getByRole('option', { name }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }

    expect(wrote).toEqual([])
  })

  it('offers no entry that is a verb', async () => {
    fleet()
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })

    await opened()
    const offered = entries().join(' ')
    for (const verb of ['Stop', 'Resume', 'Delete', 'Kill', 'Open', 'Up']) {
      expect(offered).not.toContain(verb)
    }
  })
})

/** R-23: unknown is not empty. A reading nobody could take must not become a
 *  palette that says there is nothing there. */
describe('a reading it does not have', () => {
  it('says which class could not be read', async () => {
    fleet({
      '/api/workspaces': {
        looked: 'failed',
        age_seconds: 0,
        error: 'the daemon is not there',
      },
    })
    render(<App />)
    await screen.findByText('The look failed.')

    const palette = await opened()
    expect(palette.getByText(/Workspaces could not be read\./)).toBeTruthy()
    expect(entries()).toEqual([
      'cachyos-g14',
      'Fleet',
      'Machines',
      'New workspace',
      'Settings',
      'Usage',
    ])
  })

  it('says a class it has not read yet is unread', async () => {
    fleet({ '/api/machines': { looked: 'never' } })
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })

    const palette = await opened()
    expect(palette.getByText(/Machines have not been read yet\./)).toBeTruthy()
  })
})
