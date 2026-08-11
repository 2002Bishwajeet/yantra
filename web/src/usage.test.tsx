/**
 * `/usage`, which reads one workspace's spend on request and nothing on open.
 * D3 §11.4 — with the daemon's correction to it: spend is per workspace, since
 * `yantra tokens` loads a workspace and finds its transcript. Y-183.
 *
 * The fixtures are `contract.gen.ts`'s, which are responses yantrad rendered.
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
import { spend, spendFast } from './contract.gen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.pushState(null, '', '/')
})

beforeEach(() => {
  history.pushState(null, '', '/usage')
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: 1280 < Number(/([\d.]+)rem/.exec(query)?.[1]) * 16,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
})

const yantra: Workspace = {
  name: 'yantra',
  machine: 'cachyos-g14',
  repo: '/home/<user>/Github/homelab/yantra',
  startup: null,
}

const TOKENS = '/api/workspaces/yantra/tokens'

type Answer = { status: number; body: unknown }

const answered = ({ status, body }: Answer) => ({
  ok: status < 400,
  status,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(String(body)),
})

const looked = <T,>(data: T): Looked<T> => ({
  looked: 'ok',
  age_seconds: 1,
  data,
})

/** `tokens` is a thunk so a test can hold the answer and assert what the page
 *  draws while the ssh round trip is still out. */
function daemon(tokens: () => Promise<Answer> = () => Promise.reject()) {
  const fetched = vi.fn(async (path: string, init?: { method?: string }) => {
    if (path === '/api/workspaces') {
      return answered({
        status: 200,
        body: looked([{ loaded: 'yes', ...yantra } satisfies Listed]),
      })
    }
    if (path === '/api/machines') {
      return answered({ status: 200, body: looked([] as Machine[]) })
    }
    if (path === TOKENS && init?.method === 'POST') {
      return answered(await tokens())
    }
    throw new Error(`no stub for ${init?.method ?? 'GET'} ${path}`)
  })
  vi.stubGlobal('fetch', fetched)
  return fetched
}

const asked = (fetched: ReturnType<typeof daemon>) =>
  fetched.mock.calls.filter(([path]) => path === TOKENS)

/** Choose the workspace and ask, which is the only thing that spends an ssh
 *  round trip on this page. */
async function ask() {
  fireEvent.change(await picker(), { target: { value: 'yantra' } })
  fireEvent.click(screen.getByRole('button', { name: 'Read spend' }))
}

// The workspaces read has to resolve before the picker exists, and a second is
// not always enough for one query hop on a loaded machine.
const picker = () =>
  screen.findByLabelText('Workspace', undefined, { timeout: 5_000 })

describe('the page opens holding a picker', () => {
  it('asks the daemon for no spend at all', async () => {
    const fetched = daemon()
    render(<App />)

    expect(await picker()).toBeTruthy()
    expect(asked(fetched)).toHaveLength(0)
    // The figure has no place to be drawn before it was asked for.
    expect(screen.queryByText(/at prices of/)).toBeNull()
  })

  it('posts once, to that workspace, when you ask', async () => {
    const fetched = daemon(() => Promise.resolve({ status: 200, body: spend }))
    render(<App />)
    await ask()

    await screen.findByText(/at prices of/)
    expect(asked(fetched)).toHaveLength(1)
    expect(asked(fetched)[0]![1]).toMatchObject({ method: 'POST' })
  })
})

/** The measurement `price.rs` exists to make visible: a table written into a
 *  binary reports wrong money the day a rate changes, and the date beside the
 *  figure is the only thing that says so. */
describe('the figure', () => {
  it('prints AS_OF beside the money, in the same line', async () => {
    daemon(() => Promise.resolve({ status: 200, body: spend }))
    render(<App />)
    await ask()

    const line = (await screen.findByText(/at prices of/)).closest('p')!
    expect(line.textContent).toContain('$5.46')
    expect(line.textContent).toContain(spend.as_of)
  })

  it('monospaces every figure, since Geist has no tabular digits', async () => {
    daemon(() => Promise.resolve({ status: 200, body: spend }))
    render(<App />)
    await ask()

    await screen.findByText(/at prices of/)
    for (const figure of ['$5.46', (9_530).toLocaleString(), spend.as_of]) {
      for (const drawn of screen.getAllByText(figure)) {
        expect(drawn.className).toContain('font-mono')
      }
    }
  })

  /** R-23: a model the price table does not carry is a question that could not
   *  be answered, and `$0.00` answers it. */
  it('reads an unpriced model as unpriced, never as free', async () => {
    daemon(() => Promise.resolve({ status: 200, body: spend }))
    render(<App />)
    await ask()

    expect(await screen.findByText('unpriced')).toBeTruthy()
    expect(screen.queryByText('$0.00')).toBeNull()
    // And it says which model, so the gap in the total is named rather than
    // left for the reader to find.
    expect(screen.getByText(/does not carry/).textContent).toContain('unknown')
  })

  it('shows tokens and no money for a fast-mode session', async () => {
    daemon(() => Promise.resolve({ status: 200, body: spendFast }))
    const { container } = render(<App />)
    await ask()

    // The headline, not one of the two cost cells beneath it.
    expect((await screen.findAllByText('unpriced'))[0]!.className).toContain(
      'text-lg',
    )
    expect(screen.getByText(/fast mode/).textContent).toContain(
      'this price table does not carry',
    )
    // The counts are still the answer to what it used.
    expect(screen.getByText((84_950).toLocaleString())).toBeTruthy()
    expect(container.textContent).not.toContain('$')
  })
})

describe('what a reader is owed while and after the ask', () => {
  it('shows the read still in flight rather than a finished page', async () => {
    let answer = (_: Answer) => {}
    daemon(() => new Promise<Answer>((resolve) => (answer = resolve)))
    render(<App />)
    await ask()

    expect(await screen.findByRole('button', { name: 'reading…' })).toBeTruthy()
    expect(screen.getByText(/reading the transcript/).textContent).toContain(
      'cachyos-g14',
    )
    expect(screen.queryByText(/at prices of/)).toBeNull()

    answer({ status: 200, body: spend })
    expect(await screen.findByText(/at prices of/)).toBeTruthy()
  })

  /** The daemon's 409: no transcript, or one with no turn in it yet. Neither is
   *  a failure, so neither may be drawn as one. */
  it('draws a workspace with no transcript as an answer, not an error', async () => {
    daemon(() =>
      Promise.resolve({ status: 409, body: 'no transcript for yantra' }),
    )
    render(<App />)
    await ask()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('nothing to add up yet')
    expect(alert.className).not.toContain('destructive')
    expect(alert.textContent).toContain('no transcript for yantra')
  })

  it("names what a refusal was, and keeps the daemon's whole chain", async () => {
    daemon(() =>
      Promise.resolve({ status: 503, body: 'ssh: connect to host pi port 22' }),
    )
    render(<App />)
    await ask()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('could not be asked')
    expect(alert.textContent).toContain('connect to host pi port 22')
  })

  it('stamps the answer with when it arrived', async () => {
    daemon(() => Promise.resolve({ status: 200, body: spend }))
    render(<App />)
    await ask()

    await waitFor(() =>
      expect(screen.getByText(/^read/).textContent).toMatch(/read\s*0s/),
    )
  })
})
