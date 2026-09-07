import { afterEach, describe, expect, it, vi } from 'vitest'
import { answer as answered } from '../test/daemon'
import {
  backoff,
  fetchJson,
  fields,
  fromReading,
  list,
  look,
  makeQueryClient,
  queryOptionsThrowing,
  RETRIES,
} from './client'
import { ApiError } from './errors'
import { machines as fleet, looked } from './fixtures'
import { machinesQuery } from './queries'

afterEach(() => vi.unstubAllGlobals())

const answer = (status: number, body: unknown) => vi.fn(() => Promise.resolve(answered(status, body)))

/** The write authoriser's own sentences (`write.rs`, `Refused`), verbatim. */
export const NOT_YOURS = 'node pi is on this tailnet but is not yours'
export const CANNOT_ASK =
  'could not establish who is calling: tailscale whois: connection refused'

const thrown = (run: () => Promise<unknown>) =>
  run().then(
    () => {
      throw new Error('resolved')
    },
    (cause: unknown) => cause,
  )

describe('fetchJson', () => {
  it('answers the body of a 2xx', async () => {
    vi.stubGlobal('fetch', answer(201, { name: 'site' }))
    expect(await fetchJson('/api/workspaces', { method: 'POST' })).toEqual({
      name: 'site',
    })
  })

  it('answers nothing for a 204', async () => {
    vi.stubGlobal('fetch', answer(204, undefined))
    expect(await fetchJson('/api/relay', { method: 'POST' })).toBeUndefined()
  })

  /** 403 and 503 are the two the authoriser answers, and they mean different
   *  things: one is about the caller, the other says nothing was decided. */
  it('reads a 403 as refused, with the daemon’s sentence verbatim', async () => {
    vi.stubGlobal('fetch', answer(403, NOT_YOURS))
    const error = await thrown(() =>
      fetchJson('/api/workspaces/site/up', { method: 'POST' }),
    )

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      kind: 'refused',
      status: 403,
      said: NOT_YOURS,
      retryable: false,
    })
  })

  it('reads a 503 as refused too, and never retryable', async () => {
    vi.stubGlobal('fetch', answer(503, CANNOT_ASK))
    const error = await thrown(() =>
      fetchJson('/api/workspaces/site/up', { method: 'POST' }),
    )

    expect(error).toMatchObject({
      kind: 'refused',
      status: 503,
      said: CANNOT_ASK,
      retryable: false,
    })
  })

  /** `write.rs` answers a verb's 404 as a bare string; `api.rs` answers its
   *  own as `{error}`. Both reach `said` as the sentence. */
  it('reads a 404 as missing, from a bare string or from {error}', async () => {
    vi.stubGlobal('fetch', answer(404, 'no workspace called typo'))
    const bare = await thrown(() => fetchJson('/api/workspaces/typo'))
    expect(bare).toMatchObject({
      kind: 'missing',
      status: 404,
      said: 'no workspace called typo',
    })

    vi.stubGlobal('fetch', answer(404, { error: 'this daemon serves no such route under /api' }))
    const wrapped = await thrown(() => fetchJson('/api/nowhere'))
    expect(wrapped).toMatchObject({
      kind: 'missing',
      said: 'this daemon serves no such route under /api',
    })
  })

  it('reads a body that cannot be read as contract rather than a bare error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 403,
          text: () => Promise.reject(new TypeError('stream error')),
        }),
      ),
    )
    const error = await thrown(() => fetchJson('/api/workspaces'))
    expect(error).toMatchObject({ kind: 'refused', said: 'TypeError: stream error' })
  })

  it('reads a 2xx body without its fields as contract, naming the first one missing', async () => {
    vi.stubGlobal('fetch', answer(200, {}))
    const error = await thrown(() =>
      fetchJson('/api/github', {}, fields('connected', 'login', 'scopes')),
    )
    expect(error).toMatchObject({
      kind: 'contract',
      said: '/api/github answered something this dashboard cannot read: no `connected`',
    })

    vi.stubGlobal('fetch', answer(200, { connected: false }))
    const partial = await thrown(() => fetchJson('/api/github', {}, fields('connected', 'login')))
    expect(partial).toMatchObject({ said: expect.stringContaining('no `login`') })

    vi.stubGlobal('fetch', answer(200, {}))
    const notList = await thrown(() => fetchJson('/api/notifications', {}, list))
    expect(notList).toMatchObject({ kind: 'contract', said: expect.stringContaining('no `list`') })

    vi.stubGlobal('fetch', answer(200, []))
    expect(await fetchJson('/api/notifications', {}, list)).toEqual([])
  })

  /** `null` is a request that never got an answer, which is not a refusal. */
  it('reads a daemon that never answered as network, the one retryable kind', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    const error = await thrown(() => fetchJson('/api/workspaces'))

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      kind: 'network',
      retryable: true,
      said: expect.stringContaining('Failed to fetch'),
    })
    expect((error as ApiError).status).toBeUndefined()
  })

  it('reads a 200 that is not JSON as a contract error', async () => {
    vi.stubGlobal('fetch', answer(200, '<html>not the daemon</html>'))
    const error = await thrown(() => fetchJson('/api/about'))

    expect(error).toMatchObject({
      kind: 'contract',
      status: 200,
      retryable: false,
    })
  })

  it('rethrows an abort, so Query reads the unmount as a cancellation', async () => {
    const controller = new AbortController()
    const aborted = new DOMException('aborted', 'AbortError')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        controller.abort()
        return Promise.reject(aborted)
      }),
    )
    await expect(
      fetchJson('/api/workspaces', { signal: controller.signal }),
    ).rejects.toBe(aborted)
  })
})

/** R-23: a look that failed is a fact about the fleet, so it is data. The one
 *  exception is an abort, which is this browser's and rethrown. */
describe('look', () => {
  const signal = new AbortController().signal

  it('answers the envelope the daemon rendered', async () => {
    vi.stubGlobal('fetch', answer(200, fleet))
    expect(await look('/api/machines', signal)).toEqual(fleet)
  })

  it('never throws: a non-200 is a failed look naming the status', async () => {
    vi.stubGlobal('fetch', answer(502, 'bad gateway'))
    expect(await look('/api/machines', signal)).toEqual({
      looked: 'failed',
      age_seconds: 0,
      error: '/api/machines answered 502',
    })
  })

  it('reads a body that is not an envelope as a failed look, not as data', async () => {
    vi.stubGlobal('fetch', answer(200, { machines: [] }))
    expect(await look('/api/machines', signal)).toMatchObject({
      looked: 'failed',
      error: expect.stringContaining('cannot read'),
    })
  })

  it('reads a body that is not JSON the same way', async () => {
    vi.stubGlobal('fetch', answer(200, '<html>'))
    expect(await look('/api/machines', signal)).toMatchObject({
      looked: 'failed',
      error: expect.stringContaining('cannot read'),
    })
  })

  it('rethrows an abort', async () => {
    const controller = new AbortController()
    const aborted = new DOMException('aborted', 'AbortError')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        controller.abort()
        return Promise.reject(aborted)
      }),
    )
    await expect(look('/api/machines', controller.signal)).rejects.toBe(aborted)
  })
})

describe('a failed reading as an error', () => {
  it('turns only a failed look into one, with the daemon’s sentence', () => {
    const error = fromReading(looked.failed('invalid workspace file'))
    expect(error).toBeInstanceOf(ApiError)
    expect(error?.said).toBe('invalid workspace file')
    expect(error?.describe()).toBe('The look failed.')
  })

  it('is null for the three states that are not failures', () => {
    expect(fromReading(looked.ok([]))).toBeNull()
    expect(fromReading(looked.never())).toBeNull()
    expect(fromReading({ looked: 'pending' })).toBeNull()
  })
})

describe('the query client', () => {
  const defaults = () => makeQueryClient().getDefaultOptions()
  const retry = () =>
    defaults().queries!.retry as (failures: number, error: unknown) => boolean

  it('holds errors in place rather than throwing them, unless asked', () => {
    expect(defaults().queries!.throwOnError).toBe(false)
    expect(defaults().mutations!.throwOnError).toBe(false)
    expect(queryOptionsThrowing(machinesQuery()).throwOnError).toBe(true)
    expect(queryOptionsThrowing(machinesQuery()).queryKey).toEqual(['machines'])
  })

  /** A refusal the daemon reasoned about is not worth asking again, and a
   *  missing name stays missing. */
  it('retries nothing the daemon answered', () => {
    for (const error of [
      new ApiError('refused', NOT_YOURS, { status: 403 }),
      new ApiError('refused', CANNOT_ASK, { status: 503 }),
      new ApiError('missing', 'no such workspace', { status: 404 }),
      new ApiError('contract', 'not JSON', { status: 200 }),
      new ApiError('socket', "can't find session"),
      new Error('a bare error is a bug, not a reason to retry'),
    ]) {
      expect(retry()(0, error)).toBe(false)
    }
  })

  it('asks twice more of what never answered, with backoff, and then stops', () => {
    const lost = new ApiError('network', 'Failed to fetch')
    expect(retry()(0, lost)).toBe(true)
    expect(retry()(1, lost)).toBe(true)
    expect(retry()(RETRIES, lost)).toBe(false)
    expect(defaults().queries!.retryDelay).toBe(backoff)
    expect(backoff(0)).toBe(1_000)
    expect(backoff(1)).toBe(2_000)
    expect(backoff(10)).toBe(30_000)
  })

  /** A verb that ran twice is two verbs. */
  it('never retries a mutation', () => {
    expect(defaults().mutations!.retry).toBe(false)
  })

  it('holds a reading for the length of the sweep that made it', () => {
    const { staleTime, refetchOnWindowFocus } = defaults().queries!
    expect(staleTime).toBe(30_000)
    expect(refetchOnWindowFocus).toBe(true)
  })
})
