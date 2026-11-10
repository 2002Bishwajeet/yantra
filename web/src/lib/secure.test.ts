import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { recallDraft } from '@/composer/draft'
import { about } from '../contract.gen'
import { answer } from '../test/daemon'
import { arrive, boot, toSecure, type Arrived, type Landing, type Page, type Secure } from './secure'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const ORIGIN = 'https://pi.example.ts.net:8443'
const ID = '0123456789abcdef0123456789abcdef'

/** A `Storage` over a map, so a test can read what was written. */
function store(entries: Record<string, string> = {}) {
  const held = new Map(Object.entries(entries))
  return {
    held,
    get length() {
      return held.size
    },
    key: (at: number) => [...held.keys()][at] ?? null,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  }
}

function page(isSecureContext = false, kept: Record<string, string> = {}) {
  const replace = vi.fn()
  const localStorage = store(kept)
  const here: Page = {
    isSecureContext,
    location: { pathname: '/machines/pi', search: '?tab=talk', hash: '#mic', replace },
    localStorage,
  }
  return { ...here, replace, held: localStorage.held }
}

function landing(hash: string, localStorage: Landing['localStorage'] = store(), session = store()) {
  const replaceState = vi.fn()
  const here: Landing = {
    location: { pathname: '/machines/pi', search: '?tab=talk', hash },
    history: { replaceState },
    localStorage,
    sessionStorage: session,
  }
  return { ...here, replaceState, session: session.held }
}

type Answer = (init?: RequestInit) => Promise<Response>

/** The daemon on both ports: `/api/about`, the probe of `/healthz`, and the
 *  carry, held in memory and taken once as carry.rs does. */
function stub({
  about: aboutAnswer = served(ORIGIN),
  probe = answers,
  keep,
  take,
}: { about?: Answer; probe?: Answer; keep?: Answer; take?: Answer } = {}) {
  const slots = new Map<string, string>()
  const asked = vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/about') return aboutAnswer(init)
    if (path === `${ORIGIN}/healthz`) return probe(init)
    if (path === '/api/carry') {
      if (keep) return keep(init)
      slots.set(ID, String(init?.body))
      return Promise.resolve(answer(200, { id: ID }))
    }
    const id = path.replace('/api/carry/', '')
    if (take) return take(init)
    const body = slots.get(id)
    slots.delete(id)
    return Promise.resolve(body ? answer(200, JSON.parse(body)) : answer(404, { error: 'nothing is carried' }))
  })
  vi.stubGlobal('fetch', asked)
  return asked
}

const served = (https: string | null) => () => Promise.resolve(answer(200, { ...about, https }))
const answers = () => Promise.resolve(answer(200))
const rejects = () => Promise.reject(new TypeError('Failed to fetch'))
const hangs = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
const movedTo = (result: Secure) => (result.kind === 'moved' ? result.to : '')

describe('toSecure', () => {
  it('asks nothing on a secure page', async () => {
    const asked = stub()
    const here = page(true)
    expect(await toSecure(here)).toEqual({ kind: 'secure' })
    expect(asked).not.toHaveBeenCalled()
    expect(here.replace).not.toHaveBeenCalled()
  })

  it('moves with no carry when it holds nothing to carry, and keeps the path, the search and the hash', async () => {
    const asked = stub()
    const here = page(false, { 'someone.else': 'stays' })
    const result = await toSecure(here)
    expect(result).toEqual({ kind: 'moved', to: `${ORIGIN}/machines/pi?tab=talk#mic`, carried: 0 })
    expect(here.replace).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}/machines/pi?tab=talk#mic`)
    expect(asked).toHaveBeenCalledWith(`${ORIGIN}/healthz`, expect.objectContaining({ mode: 'no-cors' }))
    expect(asked).not.toHaveBeenCalledWith('/api/carry', expect.anything())
    expect(here.held.get('someone.else')).toBe('stays')
  })

  it('leaves the keys with the daemon, puts only the id in the URL, and keeps the hash', async () => {
    const asked = stub()
    const here = page(false, {
      'yantra.prefs': '{"v":1,"theme":"dark"}',
      'yantra.editor': 'zed',
      'yantra.chat.interaction.t-1': 'plan',
      'yantra.chat.draft.t-1': 'the token is hunter2',
      'someone.else': 'stays',
    })
    const result = await toSecure(here)
    expect(result).toEqual({
      kind: 'moved',
      to: `${ORIGIN}/machines/pi?tab=talk#yantra-carry=${ID}&%23mic`,
      carried: 4,
    })
    expect(decodeURIComponent(movedTo(result))).not.toContain('hunter2')
    const [, init] = asked.mock.calls.find(([path]) => path === '/api/carry')!
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toMatchObject({ 'yantra.chat.draft.t-1': 'the token is hunter2' })
    expect([...here.held.keys()]).toEqual(['someone.else'])
  })

  it('keeps a permission mode here and sends it nowhere', async () => {
    const asked = stub()
    const here = page(false, { 'yantra.chat.mode.t-1': 'bypassPermissions', 'yantra.editor': 'zed' })
    expect(await toSecure(here)).toMatchObject({ kind: 'moved', carried: 1 })
    const [, init] = asked.mock.calls.find(([path]) => path === '/api/carry')!
    expect(String(init?.body)).not.toContain('bypassPermissions')
    expect(here.held.get('yantra.chat.mode.t-1')).toBe('bypassPermissions')
  })

  it.each([
    ['rejects', rejects, 'network'],
    ['answers 413', () => Promise.resolve(answer(413, 'length limit exceeded')), 'refused'],
    ['answers without an id', () => Promise.resolve(answer(200, {})), 'contract'],
  ])('stays, and loses no key, when the carry %s', async (_, keep, kind) => {
    stub({ keep })
    const here = page(false, { 'yantra.chat.draft.t-1': 'half a thought' })
    const result = await toSecure(here)
    expect(result.kind).toBe('carry-failed')
    expect(result.kind === 'carry-failed' && result.error.kind).toBe(kind)
    expect(here.replace).not.toHaveBeenCalled()
    expect(here.held.get('yantra.chat.draft.t-1')).toBe('half a thought')
  })

  it('stays, typed as network, and loses no key, when the carry does not answer in time', async () => {
    stub({ keep: hangs })
    const here = page(false, { 'yantra.chat.draft.t-1': 'half a thought' })
    const result = await toSecure(here, 10)
    expect(result.kind === 'carry-failed' && result.error.kind).toBe('network')
    expect(here.replace).not.toHaveBeenCalled()
    expect(here.held.get('yantra.chat.draft.t-1')).toBe('half a thought')
  })

  it('stays, typed as network, when /api/about does not answer in time', async () => {
    stub({ about: hangs })
    const here = page()
    const result = await toSecure(here, 10)
    expect(result.kind === 'about-failed' && result.error.kind).toBe('network')
    expect(here.replace).not.toHaveBeenCalled()
  })

  it('keeps a key another tab changed while the carry was made', async () => {
    const here = page(false, { 'yantra.chat.draft.t-1': 'half a thought', 'yantra.editor': 'zed' })
    stub({
      keep: () => {
        here.held.set('yantra.chat.draft.t-1', 'a whole thought')
        return Promise.resolve(answer(200, { id: ID }))
      },
    })
    expect(await toSecure(here)).toMatchObject({ kind: 'moved', carried: 2 })
    expect([...here.held.entries()]).toEqual([['yantra.chat.draft.t-1', 'a whole thought']])
  })

  it('moves with nothing to carry when the store refuses to be read', async () => {
    stub()
    const here = page()
    here.localStorage.key = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    expect(await toSecure(here)).toMatchObject({ kind: 'moved', carried: 0 })
  })

  it('stays when the daemon names no HTTPS origin', async () => {
    const asked = stub({ about: served(null) })
    const here = page()
    expect(await toSecure(here)).toEqual({ kind: 'no-origin' })
    expect(asked).toHaveBeenCalledTimes(1)
    expect(here.replace).not.toHaveBeenCalled()
  })

  it.each([
    ['rejects', rejects, 'network'],
    ['answers 500', () => Promise.resolve(answer(500, 'broken')), 'refused'],
    ['answers without the field', () => Promise.resolve(answer(200, { version: '0.1.0' })), 'contract'],
  ])('stays when /api/about %s', async (_, failing, kind) => {
    stub({ about: failing })
    const here = page()
    const result = await toSecure(here)
    expect(result.kind).toBe('about-failed')
    expect(result.kind === 'about-failed' && result.error.kind).toBe(kind)
    expect(here.replace).not.toHaveBeenCalled()
  })

  it('stays when the HTTPS origin does not answer', async () => {
    stub({ probe: rejects })
    const here = page()
    expect(await toSecure(here)).toEqual({ kind: 'unreachable' })
    expect(here.replace).not.toHaveBeenCalled()
  })

  it('stays when the HTTPS origin does not answer in time', async () => {
    stub({ probe: hangs })
    const here = page()
    expect(await toSecure(here, 10)).toEqual({ kind: 'unreachable' })
    expect(here.replace).not.toHaveBeenCalled()
  })
})

const carried = (hash = '') => `#yantra-carry=${ID}&${encodeURIComponent(hash)}`
const taking = (status: number, body?: unknown) => () => Promise.resolve(answer(status, body))

describe('arrive', () => {
  it('does nothing on a page that carries nothing', async () => {
    const asked = stub()
    const there = landing('#mic')
    expect(await arrive(there)).toEqual({ kind: 'none' })
    expect(there.replaceState).not.toHaveBeenCalled()
    expect(asked).not.toHaveBeenCalled()
  })

  it('takes the keys once, and the draft is what the composer recalls', async () => {
    stub()
    const here = page(false, { 'yantra.chat.draft.workspace/site': 'half a thought', 'yantra.editor': 'zed' })
    const there = landing(new URL(movedTo(await toSecure(here))).hash, localStorage)
    expect(await arrive(there)).toEqual({ kind: 'arrived', kept: 2 })
    expect(there.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/machines/pi?tab=talk#mic')
    expect(recallDraft('workspace/site')).toBe('half a thought')
    expect(localStorage.getItem('yantra.editor')).toBe('zed')

    expect(await arrive(landing(carried(), store()))).toEqual({ kind: 'lost' })
  })

  it('replaces what this origin holds with the carried value, which is newer', async () => {
    stub({ take: taking(200, { 'yantra.editor': 'zed' }) })
    const there = landing(carried(), store({ 'yantra.editor': 'cursor' }))
    expect(await arrive(there)).toEqual({ kind: 'arrived', kept: 1 })
    expect(there.localStorage.getItem('yantra.editor')).toBe('zed')
    expect(there.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/machines/pi?tab=talk')
  })

  it('writes no key outside the carried ones and no value that is not a string', async () => {
    stub({
      take: taking(200, {
        'yantra.chat.mode.t-1': 'bypassPermissions',
        'yantra.chat.draft.t-1': 'kept',
        'yantra.prefs': 1,
        other: 'x',
      }),
    })
    const kept = store()
    expect(await arrive(landing(carried(), kept))).toEqual({ kind: 'arrived', kept: 1 })
    expect([...kept.held.keys()]).toEqual(['yantra.chat.draft.t-1'])
  })

  it('is lost when the daemon no longer holds the slot, and still clears the address', async () => {
    stub({ take: taking(404, { error: 'nothing is carried under that id' }) })
    const there = landing(carried('#mic'))
    expect(await arrive(there)).toEqual({ kind: 'lost' })
    expect(there.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/machines/pi?tab=talk#mic')
  })

  it.each([
    ['is not hex', '#yantra-carry=not-an-id&'],
    ['is cut short', '#yantra-carry=0123'],
  ])('is lost, and asks nothing, when the id %s', async (_, hash) => {
    const asked = stub()
    const there = landing(hash)
    expect(await arrive(there)).toEqual({ kind: 'lost' })
    expect(asked).not.toHaveBeenCalled()
    expect(there.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/machines/pi?tab=talk')
  })

  it('drops a hash that breaks its encoding, and keeps the rest', async () => {
    stub({ take: taking(200, {}) })
    const there = landing(`#yantra-carry=${ID}&%E0%A4%A`)
    expect(await arrive(there)).toEqual({ kind: 'arrived', kept: 0 })
    expect(there.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/machines/pi?tab=talk')
  })

  it.each([
    ['the take rejects', rejects, 'network'],
    ['the take answers 503', taking(503, 'tailscale whois did not answer'), 'refused'],
    ['the take is refused', taking(403, 'node n-2 is on this tailnet but is not yours'), 'refused'],
    ['the take is not an object', taking(200, ['yantra.editor']), 'contract'],
  ])('fails, typed, when %s, and keeps the id so a reload asks again', async (_, take, kind) => {
    stub({ take })
    const kept = store()
    const there = landing(carried('#mic'), kept)
    const result = await arrive(there)
    expect(result.kind).toBe('failed')
    expect(result.kind === 'failed' && result.error.kind).toBe(kind)
    expect(kept.held.size).toBe(0)
    expect(there.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/machines/pi?tab=talk#mic')
    expect(there.session.get('yantra.carry')).toBe(ID)
  })

  it('fails, typed as network, when the take does not answer in time, and keeps the id', async () => {
    stub({ take: hangs })
    const there = landing(carried('#mic'))
    const result = await arrive(there, 10)
    expect(result.kind === 'failed' && result.error.kind).toBe('network')
    expect(there.session.get('yantra.carry')).toBe(ID)
  })

  it('takes the keys on the reload after a take that failed, then forgets the id', async () => {
    let first = true
    stub({
      take: () => {
        if (!first) return Promise.resolve(answer(200, { 'yantra.chat.draft.t-1': 'half a thought' }))
        first = false
        return rejects()
      },
    })
    const session = store()
    expect(await arrive(landing(carried(), store(), session))).toMatchObject({ kind: 'failed' })

    const kept = store()
    const reloaded = landing('#mic', kept, session)
    expect(await arrive(reloaded)).toEqual({ kind: 'arrived', kept: 1 })
    expect(kept.held.get('yantra.chat.draft.t-1')).toBe('half a thought')
    expect(reloaded.replaceState).not.toHaveBeenCalled()
    expect(session.held.size).toBe(0)
    expect(await arrive(landing('#mic', store(), session))).toEqual({ kind: 'none' })
  })

  it('forgets the id once the daemon no longer holds the slot', async () => {
    stub({ take: taking(404, { error: 'nothing is carried under that id' }) })
    const session = store({ 'yantra.carry': ID })
    expect(await arrive(landing('', store(), session))).toEqual({ kind: 'lost' })
    expect(session.held.size).toBe(0)
  })

  it('still takes the keys when the tab refuses session storage', async () => {
    stub({ take: taking(200, { 'yantra.editor': 'zed' }) })
    const refusing = store()
    refusing.setItem = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    refusing.getItem = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    expect(await arrive(landing(carried(), store(), refusing))).toEqual({ kind: 'arrived', kept: 1 })
    expect(await arrive(landing('', store(), refusing))).toEqual({ kind: 'none' })
  })

  it('starts with what it has when the store refuses writes', async () => {
    stub({ take: taking(200, { 'yantra.editor': 'zed' }) })
    const refusing = store()
    refusing.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    expect(await arrive(landing(carried(), refusing))).toEqual({ kind: 'arrived', kept: 0 })
  })
})

describe('boot', () => {
  const land = () => Promise.resolve<Arrived>({ kind: 'none' })

  it('does not render a page that moves', async () => {
    const render = vi.fn()
    const moved: Secure = { kind: 'moved', to: ORIGIN, carried: 0 }
    expect(await boot(render, () => Promise.resolve(moved), land)).toEqual(moved)
    expect(render).not.toHaveBeenCalled()
  })

  it.each<Arrived>([
    { kind: 'none' },
    { kind: 'arrived', kept: 1 },
    { kind: 'lost' },
    { kind: 'failed', error: new ApiError('network', 'Failed to fetch') },
  ])('renders after the carry has landed as $kind', async (landed) => {
    const order: string[] = []
    const render = vi.fn(() => order.push('render'))
    const stays = () => {
      order.push('move')
      return Promise.resolve({ kind: 'secure' } as const)
    }
    const landing = async () => {
      await Promise.resolve()
      order.push('land')
      return landed
    }
    await boot(render, stays, landing)
    expect(order).toEqual(['land', 'move', 'render'])
    expect(render).toHaveBeenCalledWith(landed)
  })

  it('renders even when the move throws', async () => {
    const render = vi.fn()
    await expect(boot(render, () => Promise.reject(new Error('boom')), land)).rejects.toThrow('boom')
    expect(render).toHaveBeenCalledExactlyOnceWith({ kind: 'none' })
  })
})
