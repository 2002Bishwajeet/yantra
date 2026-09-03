/**
 * The spend tab of `/w/{name}` — D5 §6, Y-311.
 *
 * **It is `/usage`'s answer with the picker removed.** So what this file asserts
 * is the difference: no picker, the workspace taken from the URL, one read held
 * above the tab, and §6.2's headline. What `Answer` and `Figure` draw from an
 * `Asked` is `usage.test.tsx`'s subject, and they are the same two components.
 *
 * The fixtures are `contract.gen.ts`'s, which are responses yantrad rendered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Listed } from './api'
import App from './App'
import { logs, spend, spendFast } from './contract.gen'

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

const yantra: Listed = {
  loaded: 'yes',
  name: 'yantra',
  machine: 'cachyos-g14',
  repo: '/home/<user>/Github/homelab/yantra',
  startup: null,
}

const TOKENS = '/api/workspaces/yantra/tokens'

type Reply = { status: number; body: unknown }

const answered = ({ status, body }: Reply) => ({
  ok: status < 400,
  status,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(String(body)),
})

/** `tokens` is a thunk so a test can hold the ssh open and see what the tab
 *  draws meanwhile. Every other path answers what the page needs to get as far
 *  as the tab bar. */
function daemon(tokens: () => Promise<Reply> = () => Promise.resolve({ status: 200, body: spend })) {
  const fetched = vi.fn(async (path: string, init?: { method?: string }) => {
    if (path === '/api/viewing') return { ok: true, status: 204 }
    if (path === TOKENS && init?.method === 'POST') {
      return answered(await tokens())
    }
    return answered({
      status: 200,
      body:
        path === '/api/workspaces'
          ? { looked: 'ok', age_seconds: 1, data: [yantra] }
          : path === '/api/workspaces/yantra/logs'
            ? logs
            : { looked: 'never' },
    })
  })
  vi.stubGlobal('fetch', fetched)
  return fetched
}

const reads = (fetched: ReturnType<typeof daemon>) =>
  fetched.mock.calls.filter(([path]) => path === TOKENS)

function open(url = '/w/yantra?view=spend', tokens?: () => Promise<Reply>) {
  const fetched = daemon(tokens)
  history.pushState(null, '', url)
  render(<App />)
  return fetched
}

/** The four token fields the strip carries. `responses` is not one of them: a
 *  response is not a token, and the headline counts tokens. */
const tokens = (of: typeof spend.total) =>
  of.input + of.output + of.cache_write + of.cache_read

describe('the spend tab passes no picker', () => {
  it('takes the workspace from the URL and offers nothing to choose', async () => {
    open()

    await screen.findByText(/tokens, unpriced/)
    expect(screen.queryByLabelText('Workspace')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Read spend' })).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  /** D5 §6.1: the tab is `/usage`'s answer, so the two subjects that answer
   *  names — the workspace and the one session it counted — are drawn here by
   *  the same component. */
  it('draws the shared answer against the workspace in the URL', async () => {
    open()

    await screen.findByText(/tokens, unpriced/)
    expect(
      screen.getByRole('heading', { level: 2, name: 'yantra' }),
    ).toBeTruthy()
    const line = screen.getByText(/^session/)
    expect(line.textContent).toContain('cachyos-g14')
    // `Figure`'s own three bands: the strip, the model table and the path.
    expect(screen.getByText('cache write')).toBeTruthy()
    expect(screen.getByText('claude-opus-5-20260115')).toBeTruthy()
    expect(screen.getByText(spend.path)).toBeTruthy()
  })
})

/** D5 §3.5 and §6.1. Only the open tab is mounted, so mounting this one is the
 *  press the picker's own button was — and the answer is held above the tab, so
 *  a reader who goes to the terminal and comes back spends no second ssh. */
describe('one read, held above the tab', () => {
  it('reads once when the tab opens, and nothing before it', async () => {
    const fetched = open('/w/yantra?view=terminal')

    await screen.findByText('Terminal — yantra')
    expect(reads(fetched)).toHaveLength(0)

    fireEvent.click(screen.getByRole('link', { name: 'spend' }))

    await screen.findByText(/tokens, unpriced/)
    expect(reads(fetched)).toHaveLength(1)
    expect(reads(fetched)[0]![1]).toMatchObject({ method: 'POST' })
  })

  it('does not read again when the reader comes back from the terminal', async () => {
    const fetched = open()
    await screen.findByText(/tokens, unpriced/)

    fireEvent.click(screen.getByRole('link', { name: 'terminal' }))
    await screen.findByText('Terminal — yantra')
    fireEvent.click(screen.getByRole('link', { name: 'spend' }))

    await screen.findByText(/tokens, unpriced/)
    expect(reads(fetched)).toHaveLength(1)
  })

  it('re-reads when Refresh is pressed, and only then', async () => {
    const fetched = open()
    await screen.findByText(/tokens, unpriced/)
    expect(reads(fetched)).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(reads(fetched)).toHaveLength(2))
  })

  it('says the ssh is still out rather than showing a finished page', async () => {
    let answer = (_: Reply) => {}
    open('/w/yantra?view=spend', () => new Promise<Reply>((r) => (answer = r)))

    expect(
      (await screen.findByText(/reading the transcript/)).textContent,
    ).toContain('cachyos-g14')
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()

    answer({ status: 200, body: spend })
    expect(await screen.findByText(/tokens, unpriced/)).toBeTruthy()
  })
})

/** **D5 §6.2.** Where any model is unpriced the headline is the token count,
 *  the dollar line is absent, and the unpriced model is named underneath.
 *
 *  The daemon still sends a `cost` for a partly-priced session — it sums the
 *  models the table prices — so this is the browser refusing a figure the wire
 *  carries, one level up from the `$0.00` per model that R-23 already refuses.
 */
describe('a session with any unpriced model', () => {
  it('makes tokens the headline and draws no dollar line at all', async () => {
    open()
    const headline = await screen.findByText(
      tokens(spend.total).toLocaleString(),
    )

    const band = screen.getByText('this session').parentElement!

    expect(headline.className).toContain('text-lg')
    expect(headline.className).toContain('font-mono')
    expect(band.textContent).toContain('tokens, unpriced')
    // `$5.46` is what the wire carried for this session, and `at prices of` is
    // the date that always sits beside it. Neither is drawn.
    expect(band.textContent).not.toContain('$')
    expect(document.body.textContent).not.toContain('at prices of')
  })

  /** **The line §6.2 draws is the session's, not the table's.** A per-model
   *  figure understates nothing, so the table still prices what the price table
   *  prices — and still calls the rest unpriced. Dropping those cells would
   *  throw away the only money that survived. */
  it('keeps the per-model costs the table can still answer', async () => {
    open()

    await screen.findByText(/tokens, unpriced/)
    expect(screen.getByText('$5.46')).toBeTruthy()
    expect(screen.getByText('unpriced')).toBeTruthy()
  })

  it('names the model the price table does not carry', async () => {
    open()

    await screen.findByText(/tokens, unpriced/)
    expect(screen.getByText(/does not carry/).textContent).toContain('unknown')
    // The models are still listed, and the unpriced one still says so.
    expect(screen.getByText('unpriced')).toBeTruthy()
    expect(screen.queryByText('$0.00')).toBeNull()
  })

  /** A fast-mode session takes the same shape and says so in its own words
   *  rather than borrowing the unpriced ones. */
  it('gives fast mode the same headline and its own sentence', async () => {
    open('/w/yantra?view=spend', () =>
      Promise.resolve({ status: 200, body: spendFast }),
    )

    const headline = await screen.findByText(
      tokens(spendFast.total).toLocaleString(),
    )
    expect(headline.className).toContain('text-lg')
    expect(screen.getByText(/fast mode/).textContent).toContain(
      'this price table does not carry',
    )
    expect(screen.queryByText(/Not every model below is priced/)).toBeNull()
    expect(document.body.textContent).not.toContain('$')
  })
})
