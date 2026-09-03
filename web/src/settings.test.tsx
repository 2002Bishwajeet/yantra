/**
 * `/settings`, which writes the ntfy relay, and the beacon that stops the
 * daemon pushing what this page is already showing. D3 §12.2, §13, Y-199.
 *
 * The two are one file because they are one decision: the relay is worth
 * setting because Yantra pushes to it, and the beacon is when it does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { Looked } from './api'
import App from './App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  history.pushState(null, '', '/')
  visibility('visible')
})

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: 1280 < Number(/([\d.]+)rem/.exec(query)?.[1]) * 16,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
})

/** jsdom has no page to hide, so the property is the API. `visibilitychange` is
 *  fired by hand for the same reason. */
function visibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

const empty: Looked<never[]> = { looked: 'ok', age_seconds: 1, data: [] }

/** `relay` is a thunk so a test can decide what the daemon answers, including
 *  the 502 that means *written, and not delivered*. */
function daemon(
  relay: () => { status: number; said: string } = () => ({
    status: 204,
    said: '',
  }),
) {
  const fetched = vi.fn((path: string, init?: { method?: string }) => {
    if (path === '/api/relay' || path === '/api/viewing') {
      const { status, said } = relay()
      return Promise.resolve({
        ok: status < 400,
        status,
        text: () => Promise.resolve(said),
        json: () => Promise.resolve(null),
      })
    }
    if (init?.method) throw new Error(`no stub for ${init.method} ${path}`)
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(empty),
    })
  })
  vi.stubGlobal('fetch', fetched)
  return fetched
}

const posted = (fetched: ReturnType<typeof daemon>, path: string) =>
  fetched.mock.calls.filter(
    ([called, init]) =>
      called === path && (init as { method?: string } | undefined)?.method === 'POST',
  )

const body = (call: unknown[]) =>
  JSON.parse(String((call[1] as { body?: string }).body)) as Record<
    string,
    unknown
  >

async function fill(url: string, token?: string) {
  fireEvent.change(await screen.findByLabelText('Topic URL'), {
    target: { value: url },
  })
  if (token !== undefined) {
    fireEvent.change(screen.getByLabelText('Token'), {
      target: { value: token },
    })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Save and send a test' }))
}

describe('the relay form', () => {
  it('sends the topic and the token to the one route that writes them', async () => {
    history.pushState(null, '', '/settings')
    const fetched = daemon()
    render(<App />)

    await fill('https://ntfy.sh/a-topic', 'tk_notarealtoken')

    await waitFor(() => expect(posted(fetched, '/api/relay')).toHaveLength(1))
    expect(body(posted(fetched, '/api/relay')[0]!)).toEqual({
      url: 'https://ntfy.sh/a-topic',
      token: 'tk_notarealtoken',
    })
    expect(
      await screen.findByText('The test message arrived at the relay.'),
    ).toBeTruthy()
  })

  /** An open topic and a topic with a blank password are not the same thing,
   *  and an empty string would be written into the file as the second. */
  it('omits the token rather than sending an empty one', async () => {
    history.pushState(null, '', '/settings')
    const fetched = daemon()
    render(<App />)

    await fill('https://ntfy.sh/a-topic')

    await waitFor(() => expect(posted(fetched, '/api/relay')).toHaveLength(1))
    expect(body(posted(fetched, '/api/relay')[0]!)).toEqual({
      url: 'https://ntfy.sh/a-topic',
    })
  })

  /** The daemon writes before it sends, so a 502 is not a failed save — and a
   *  page that says "failed" has someone type it all in again. */
  it('says a 502 wrote the relay and did not deliver the message', async () => {
    history.pushState(null, '', '/settings')
    daemon(() => ({
      status: 502,
      said: 'the relay is written down in /etc/yantra/daemon.env, and the test message did not arrive: the relay answered 401',
    }))
    render(<App />)

    await fill('https://ntfy.sh/a-topic', 'tk_wrong')

    expect(
      await screen.findByText(
        'The relay is written down, and the test message did not arrive.',
      ),
    ).toBeTruthy()
    expect(screen.getByText(/answered 401/)).toBeTruthy()
  })

  /** §B4 holds everywhere ADR-0021 did not carve: nothing reads a relay back,
   *  so the page cannot put a token on the wire in the other direction. */
  it('reads no relay from the daemon when it opens', async () => {
    history.pushState(null, '', '/settings')
    const fetched = daemon()
    render(<App />)

    await screen.findByLabelText('Topic URL')
    expect(
      fetched.mock.calls.filter(([path]) => String(path).includes('/api/relay')),
    ).toHaveLength(0)
  })
})

describe('the presence beacon', () => {
  it('says the page is open, once, as soon as it is', async () => {
    const fetched = daemon()
    render(<App />)

    await waitFor(() => expect(posted(fetched, '/api/viewing')).toHaveLength(1))
  })

  /** The rule the beacon exists for: a background tab polls `/api` every 5 s
   *  and is not a person watching, so a hidden page says nothing at all. */
  it('stops the moment the tab is hidden, and starts again when it is not', async () => {
    const fetched = daemon()
    render(<App />)
    await waitFor(() => expect(posted(fetched, '/api/viewing')).toHaveLength(1))

    visibility('hidden')
    expect(posted(fetched, '/api/viewing')).toHaveLength(1)

    visibility('visible')
    await waitFor(() => expect(posted(fetched, '/api/viewing')).toHaveLength(2))
  })
})
