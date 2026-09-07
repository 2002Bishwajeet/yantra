/**
 * `/w/$name/repair`, the one surface that edits a workspace as text (D3 §7.5).
 *
 * **The refusals are the subject**, which is
 * [ADR-0020](../../../../docs/adr/0020-a-raw-write-only-from-broken-to-valid.md)'s
 * own convention. The daemon owns both and `workspace.rs` proves them against
 * a real filesystem; what this asserts is that the page draws each one rather
 * than swallowing it, and that it opens on a file that will not load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import type { Broken } from '@/api'
import { makeQueryClient } from '@/api/client'
import { Repair } from './Repair'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// TanStack Router scrolls on navigation and jsdom implements no `scrollTo`.
beforeEach(() => vi.stubGlobal('scrollTo', () => {}))

const site: Broken = {
  name: 'site',
  path: '/home/me/.config/yantra/workspaces/site.toml',
  text: 'machine = "pi"\nrepo =\n',
  error:
    'workspace `site` at /home/me/.config/yantra/workspaces/site.toml is not valid TOML: TOML parse error at line 2, column 7',
}

/** One stub for both halves of the route: the `GET` answers `opened` and the
 *  `POST` answers `posted`. Returns the bodies the page sent. */
function daemon(
  opened: { status: number; body: unknown },
  posted?: { status: number; body: unknown },
) {
  const sent: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((_path: string, init?: RequestInit) => {
      const answer = init?.method === 'POST' ? posted! : opened
      if (init?.body) sent.push(String(init.body))
      const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
      return Promise.resolve({
        ok: answer.status < 400,
        status: answer.status,
        json: () => Promise.resolve(answer.body),
        text: () => Promise.resolve(text),
      })
    }),
  )
  return sent
}

/** The route and the two it links to, and nothing of the shell. */
function open(path = '/w/site/repair') {
  const root = createRootRoute()
  const routes = [
    createRoute({ getParentRoute: () => root, path: '/fleet', component: () => <p>the fleet</p> }),
    createRoute({ getParentRoute: () => root, path: '/w/$name', component: () => <p>the workspace</p> }),
    createRoute({ getParentRoute: () => root, path: '/w/$name/repair', component: Repair }),
  ]
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

const box = () => screen.findByLabelText('The file') as Promise<HTMLTextAreaElement>

describe('the repair page', () => {
  it('draws the file, the reason it will not load, and marks the line', async () => {
    daemon({ status: 200, body: site })
    open()

    expect((await box()).value).toBe(site.text)
    expect(screen.getByRole('heading', { level: 1, name: 'Repair site' })).toBeTruthy()
    expect(screen.getByText(site.path)).toBeTruthy()
    expect(screen.getByText('site will not load.')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(site.error)
    expect(screen.getByText('2 lines')).toBeTruthy()

    const gutter = document.querySelector('.repair__gutter')!
    expect(gutter.querySelector('[data-error]')?.textContent).toBe('2')
    expect(document.querySelector('.repair__line[data-error] .repair__marker')?.textContent).toBe(
      'TOML parse error',
    )
    expect(screen.getByRole('link', { name: 'Cancel' }).getAttribute('href')).toBe('/w/site')
  })

  it('draws bars, never a sentence, while the file is out', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    open()
    await waitFor(() => expect(document.querySelector('[data-slot="reading"]')).toBeTruthy())
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  /** ADR-0020's first bound, drawn: the daemon refuses to hand over a file that
   *  loads, so this page can never become a second way to edit a good one. */
  it('offers no editor for a file that loads', async () => {
    daemon({ status: 409, body: 'workspace `site` at … loads' })
    open()

    expect(await screen.findByText('That file loads, so there is nothing to repair.')).toBeTruthy()
    expect(screen.getByText('workspace `site` at … loads')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open site' }).getAttribute('href')).toBe('/w/site')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.queryByLabelText('The file')).toBeNull()
  })

  it('is the not-found board for a name the daemon does not know', async () => {
    daemon({ status: 404, body: { error: 'no workspace named site' } })
    open()

    expect(await screen.findByText('No workspace is called site.')).toBeTruthy()
    expect(screen.getByText('The fleet lists the ones there are.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Fleet' }).getAttribute('href')).toBe('/fleet')
  })

  /** ADR-0020's second bound. The daemon names the *next* error, and the page
   *  keeps what was typed — a refusal that cleared the box would throw away the
   *  half of the repair that was right. */
  it('keeps the bytes on screen when the daemon names the next error', async () => {
    const sent = daemon(
      { status: 200, body: site },
      { status: 400, body: 'workspace `site` has an empty `repo` at line 2' },
    )
    open()

    const text = await box()
    fireEvent.change(text, { target: { value: 'machine = "pi"\nrepo = ""\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Those bytes still will not load.')).toBeTruthy()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('has an empty `repo`')
    expect(alert.textContent).not.toContain('TOML parse error')
    expect(text.value).toBe('machine = "pi"\nrepo = ""\n')
    expect(sent).toEqual([JSON.stringify({ text: 'machine = "pi"\nrepo = ""\n' })])
    expect(document.querySelector('.repair__marker')?.textContent).toBe('workspace `site` has an empty `repo`')
  })

  it('opens the workspace once the daemon has taken the bytes', async () => {
    daemon(
      { status: 200, body: site },
      { status: 200, body: { name: 'site', machine: 'pi', repo: '/srv/site', startup: null } },
    )
    const router = open()

    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))

    expect(await screen.findByText('the workspace')).toBeTruthy()
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/site'))
    expect(screen.queryByText('That file loads, so there is nothing to repair.')).toBeNull()
  })
})
