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

beforeEach(() => {
  served = {}
  offline = false
  cached = new Map()
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
    clients: { claim: async () => {} },
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
