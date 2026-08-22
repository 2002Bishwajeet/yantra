/**
 * Y-190's last clause: `/w/{name}/repair`, the one surface that edits a
 * workspace as text (D3 §7.5).
 *
 * **The refusals are the subject**, which is
 * [ADR-0020](../../docs/adr/0020-a-raw-write-only-from-broken-to-valid.md)'s own
 * convention. The daemon owns both of them and `workspace.rs` proves them
 * against a real filesystem; what this asserts is that the page draws each one
 * rather than swallowing it, and that it opens on a file that will not load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { Broken } from './api'
import App from './App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
})

beforeEach(() => {
  // TanStack Router scrolls on navigation and jsdom implements no `scrollTo`.
  vi.stubGlobal('scrollTo', () => {})
  history.pushState(null, '', '/w/site/repair')
})

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
      return Promise.resolve({
        ok: answer.status < 400,
        status: answer.status,
        json: () => Promise.resolve(answer.body),
        text: () => Promise.resolve(String(answer.body)),
      })
    }),
  )
  return sent
}

describe('the repair page', () => {
  it('draws the file and the reason it will not load', async () => {
    daemon({ status: 200, body: site })

    render(<App />)

    const box = (await screen.findByLabelText('The file')) as HTMLTextAreaElement
    expect(box.value).toBe(site.text)
    expect(screen.getByText(site.error)).toBeTruthy()
  })

  /** ADR-0020's first bound, drawn: the daemon refuses to hand over a file that
   *  loads, so this page can never become a second way to edit a good one. */
  it('offers no editor for a file that loads', async () => {
    daemon({ status: 409, body: 'workspace `site` at … loads' })

    render(<App />)

    expect(
      await screen.findByText('That file loads, so there is nothing to repair.'),
    ).toBeTruthy()
    expect(screen.queryByLabelText('The file')).toBeNull()
  })

  /** ADR-0020's second bound. The daemon names the *next* error, and the page
   *  keeps what was typed — a refusal that cleared the box would throw away the
   *  half of the repair that was right. */
  it('keeps the bytes on screen when the daemon names the next error', async () => {
    const sent = daemon(
      { status: 200, body: site },
      { status: 400, body: 'workspace `site` at … has an empty `repo`' },
    )

    render(<App />)
    const box = (await screen.findByLabelText('The file')) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'machine = "pi"\nrepo = ""\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save the file' }))

    expect(
      await screen.findByText('Those bytes still will not load.'),
    ).toBeTruthy()
    expect(screen.getByText(/has an empty `repo`/)).toBeTruthy()
    expect(box.value).toBe('machine = "pi"\nrepo = ""\n')
    expect(sent).toEqual([
      JSON.stringify({ text: 'machine = "pi"\nrepo = ""\n' }),
    ])
  })

  it('says the workspace loads once the daemon has taken the bytes', async () => {
    daemon(
      { status: 200, body: site },
      {
        status: 200,
        body: { name: 'site', machine: 'pi', repo: '/srv/site', startup: null },
      },
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save the file' }))

    await waitFor(() =>
      expect(screen.getByText('site loads now, on pi.')).toBeTruthy(),
    )
    expect(screen.queryByLabelText('The file')).toBeNull()
  })
})
