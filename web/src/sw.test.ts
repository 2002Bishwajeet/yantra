import { beforeEach, describe, expect, it } from 'vitest'
// The worker is plain JS in `public/`, so this runs the file that ships rather
// than a copy of it: `new Function` gives it the three names it takes from its
// global scope, and everything below stands in for the browser's side of them.
import source from '../public/sw.js?raw'

// The MagicDNS short name, because `<tailnet>` is not a parseable host and the
// origin only has to be one thing consistently.
const ORIGIN = 'https://cachyos-g14:8443'

type FakeRequest = { url: string; method: string; mode: string }

type FetchEvent = {
  request: FakeRequest
  answer?: Promise<Response>
  respondWith(answer: Promise<Response>): void
}

let served: Record<string, string>
let offline: boolean
let cached: Map<string, Response>

type Shown = { title: string; body?: string; icon?: string; data?: { url?: string } }
type Client = {
  url: string
  controlled: boolean
  focused: boolean
  visibilityState?: 'visible' | 'hidden'
  /** `focus()` throws, as it does for a window the browser will not raise. */
  stuck?: boolean
  told?: unknown[]
}

let shown: Shown[]
let clients: Client[]
let opened: string[]

beforeEach(() => {
  served = {}
  offline = false
  cached = new Map()
  shown = []
  clients = []
  opened = []
})

const href = (key: FakeRequest | string) =>
  new URL(typeof key === 'string' ? key : key.url, ORIGIN).href

async function network(key: FakeRequest | string): Promise<Response> {
  if (offline) throw new TypeError('Failed to fetch')
  const body = served[new URL(href(key)).pathname]
  return body === undefined
    ? new Response('no such file', { status: 404 })
    : new Response(body, { status: 200 })
}

const cache = {
  put: async (key: FakeRequest | string, response: Response) => {
    cached.set(href(key), response)
  },
  match: async (key: FakeRequest | string) => cached.get(href(key)),
  add: async (key: string) => {
    const response = await network(key)
    if (!response.ok) throw new Error(key)
    cached.set(href(key), response)
  },
}

function load() {
  const handlers: Record<string, (event: never) => void> = {}
  const worker = {
    addEventListener: (kind: string, handler: (event: never) => void) => {
      handlers[kind] = handler
    },
    location: { origin: ORIGIN },
    skipWaiting: () => {},
    registration: {
      showNotification: async (title: string, options: Omit<Shown, 'title'>) => {
        shown.push({ title, ...options })
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () =>
        clients.map((client) => ({
          focused: client.focused,
          visibilityState: client.visibilityState ?? 'hidden',
          navigate: async (url: string) => {
            if (!client.controlled) throw new TypeError('not controlled')
            client.url = url
            // The page that loads is a new client, and that one takes the focus.
            return { focus: async () => void (client.focused = true) }
          },
          focus: async () => {
            if (client.stuck) throw new TypeError('not focused')
            client.focused = true
          },
          postMessage: (message: unknown) => {
            client.told = [...(client.told ?? []), message]
          },
        })),
      openWindow: async (url: string) => {
        opened.push(url)
      },
    },
  }
  new Function('self', 'caches', 'fetch', source)(
    worker,
    { open: async () => cache },
    network,
  )
  return handlers
}

function request(path: string, over: Partial<FakeRequest> = {}): FakeRequest {
  return { url: href(path), method: 'GET', mode: 'no-cors', ...over }
}

/** `undefined` is the answer that matters: nothing was intercepted, so the
 *  browser makes the request itself and a dead daemon reaches the page. */
async function ask(
  handlers: Record<string, (event: never) => void>,
  path: string,
  over: Partial<FakeRequest> = {},
): Promise<string | undefined> {
  const event: FetchEvent = {
    request: request(path, over),
    respondWith(answer) {
      event.answer = answer
    },
  }
  handlers.fetch?.(event as never)
  return event.answer && (await event.answer).text()
}

async function install(handlers: Record<string, (event: never) => void>) {
  let waited: Promise<unknown> = Promise.resolve()
  const waitUntil = (pending: Promise<unknown>) => {
    waited = pending
  }
  handlers.install?.({ waitUntil } as never)
  await waited
}

describe('the service worker', () => {
  it('never caches a reading, and never answers one', async () => {
    served['/api/machines'] = '{"looked":"ok","age_seconds":3,"data":[]}'
    const handlers = load()

    expect(await ask(handlers, '/api/machines')).toBeUndefined()
    expect(cached.size).toBe(0)
  })

  it('does not answer a reading from cache even when one is in there', async () => {
    cached.set(href('/api/machines'), new Response('a fleet that looked fine'))
    offline = true
    const handlers = load()

    expect(await ask(handlers, '/api/machines')).toBeUndefined()
  })

  /** The socket is under `/api`, so the exclusion that already existed covers
   *  it — and a handshake never reaches a worker's `fetch` at all. Both are why
   *  this is a test rather than a line of code: moving the route out from under
   *  `/api` is what would put a terminal in the cache, and it would do it
   *  silently. */
  it('never intercepts the terminal socket, handshake or path', async () => {
    served['/api/workspaces/yantra/terminal'] = 'a shell'
    const handlers = load()

    expect(await ask(handlers, '/api/workspaces/yantra/terminal')).toBeUndefined()
    expect(
      await ask(handlers, '/api/workspaces/yantra/terminal', {
        mode: 'websocket',
      }),
    ).toBeUndefined()
    expect(cached.size).toBe(0)
  })

  it('leaves the daemon its other routes and every write alone', async () => {
    const handlers = load()

    expect(await ask(handlers, '/healthz')).toBeUndefined()
    expect(await ask(handlers, '/heartbeat', { method: 'POST' })).toBeUndefined()
    expect(
      await ask(handlers, '/api/workspaces', { method: 'POST' }),
    ).toBeUndefined()
  })

  it('serves the shell offline, including a deep link', async () => {
    served['/'] = '<script src="/assets/app.js"></script>the shell'
    served['/assets/app.js'] = 'the app'
    const handlers = load()
    await install(handlers)

    offline = true
    expect(await ask(handlers, '/workspaces/yantra', { mode: 'navigate' })).toBe(
      served['/'],
    )
    expect(await ask(handlers, '/assets/app.js')).toBe('the app')
  })

  it('takes the network over the cache whenever there is one', async () => {
    served['/'] = 'the old shell'
    const handlers = load()
    await install(handlers)

    served['/'] = 'the new shell'
    expect(await ask(handlers, '/', { mode: 'navigate' })).toBe('the new shell')
    expect(await cached.get(href('/'))?.text()).toBe('the new shell')
  })
})

/** Runs a handler that hands its work to `waitUntil`, and waits for the work. */
async function settle(handler: ((event: never) => void) | undefined, event: object) {
  let waited: Promise<unknown> = Promise.resolve()
  handler?.({ ...event, waitUntil: (pending: Promise<unknown>) => (waited = pending) } as never)
  await waited
}

const push = (handlers: Record<string, (event: never) => void>, data: unknown) =>
  settle(handlers.push, { data })

async function tap(handlers: Record<string, (event: never) => void>, url: string | undefined) {
  let closed = false
  await settle(handlers.notificationclick, { notification: { data: { url }, close: () => (closed = true) } })
  return closed
}

describe('a push (ADR-0047)', () => {
  it('shows what the daemon sent, with the page a tap opens', async () => {
    const said = { title: 'Approval needed', body: "api: waiting at claude's trust prompt", url: '/w/api' }
    await push(load(), { json: () => said })

    expect(shown).toEqual([
      { title: said.title, body: said.body, icon: '/icon-192.png', data: { url: '/w/api' } },
    ])
  })

  it('still shows a notification for a push it cannot read, or one with no data', async () => {
    const handlers = load()
    await push(handlers, {
      json: () => {
        throw new SyntaxError('not JSON')
      },
    })
    await push(handlers, null)

    expect(shown).toEqual([
      { title: 'Yantra', body: '', icon: '/icon-192.png', data: { url: '/' } },
      { title: 'Yantra', body: '', icon: '/icon-192.png', data: { url: '/' } },
    ])
  })
})

describe('a tap on a notification (ADR-0047)', () => {
  it('focuses the open dashboard and tells its router the page, with no reload', async () => {
    clients = [{ url: `${ORIGIN}/fleet`, controlled: true, focused: false }]

    expect(await tap(load(), '/w/api?thread=1a2b')).toBe(true)

    expect(clients).toEqual([
      { url: `${ORIGIN}/fleet`, controlled: true, focused: true, told: [{ open: '/w/api?thread=1a2b' }] },
    ])
    expect(opened).toEqual([])
  })

  it('picks the focused window, then a visible one, over the first', async () => {
    clients = [
      { url: `${ORIGIN}/fleet`, controlled: true, focused: false },
      { url: `${ORIGIN}/rooms`, controlled: true, focused: false, visibilityState: 'visible' },
      { url: `${ORIGIN}/settings`, controlled: true, focused: true, visibilityState: 'visible' },
    ]
    const handlers = load()

    await tap(handlers, '/w/api')
    expect(clients.map((client) => client.told)).toEqual([undefined, undefined, [{ open: '/w/api' }]])

    clients[2]!.focused = false
    await tap(handlers, '/w/web')
    expect(clients[1]?.told).toEqual([{ open: '/w/web' }])
    expect(clients[0]?.told).toBeUndefined()
  })

  it('navigates a window that does not take the focus', async () => {
    clients = [{ url: `${ORIGIN}/fleet`, controlled: true, focused: false, stuck: true }]

    await tap(load(), '/w/api')

    expect(clients).toEqual([{ url: `${ORIGIN}/w/api`, controlled: true, focused: true, stuck: true }])
    expect(opened).toEqual([])
  })

  it('opens a window when no dashboard is open', async () => {
    await tap(load(), '/rooms/design')

    expect(opened).toEqual([`${ORIGIN}/rooms/design`])
  })

  it('opens a window when the open one cannot be moved', async () => {
    clients = [{ url: `${ORIGIN}/fleet`, controlled: false, focused: false, stuck: true }]

    await tap(load(), '/w/api')

    expect(opened).toEqual([`${ORIGIN}/w/api`])
    expect(clients[0]?.focused).toBe(false)
  })

  it('never leaves the dashboard for another site', async () => {
    const handlers = load()

    await tap(handlers, 'https://evil.example/login')
    await tap(handlers, '//evil.example/login')
    await tap(handlers, undefined)

    expect(opened).toEqual([`${ORIGIN}/`, `${ORIGIN}/`, `${ORIGIN}/`])

    clients = [{ url: `${ORIGIN}/fleet`, controlled: true, focused: true }]
    await tap(handlers, 'https://evil.example/login')
    expect(clients[0]?.told).toEqual([{ open: '/' }])
  })
})
