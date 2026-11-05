import { afterEach, describe, expect, it, vi } from 'vitest'
import { about } from '../contract.gen'
import { answer } from '../test/daemon'
import { arrive, boot, toSecure, type Landing, type Page, type Secure } from './secure'

afterEach(() => vi.unstubAllGlobals())

const ORIGIN = 'https://pi.example.ts.net:8443'

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

function landing(hash: string, kept: Record<string, string> = {}) {
  const replaceState = vi.fn()
  const localStorage = store(kept)
  const here: Landing = {
    location: { pathname: '/machines/pi', search: '?tab=talk', hash },
    history: { replaceState },
    localStorage,
  }
  return { ...here, replaceState, held: localStorage.held }
}

/** `/api/about` answers `aboutAnswer`; the probe of `/healthz` does `probe`. */
function stub(aboutAnswer: () => Promise<Response>, probe: (init?: RequestInit) => Promise<Response>) {
  const asked = vi.fn((path: string, init?: RequestInit) =>
    path === '/api/about' ? aboutAnswer() : probe(init),
  )
  vi.stubGlobal('fetch', asked)
  return asked
}

const served = (https: string | null) => () => Promise.resolve(answer(200, { ...about, https }))
const answers = () => Promise.resolve(answer(200))

describe('toSecure', () => {
  it('asks nothing on a secure page', async () => {
    const asked = stub(served(ORIGIN), answers)
    const here = page(true)
    expect(await toSecure(here)).toEqual({ kind: 'secure' })
    expect(asked).not.toHaveBeenCalled()
    expect(here.replace).not.toHaveBeenCalled()
  })

  it('moves to the HTTPS origin and keeps the path, the search and the hash', async () => {
    const asked = stub(served(ORIGIN), answers)
    const here = page()
    const result = await toSecure(here)
    expect(result.kind).toBe('moved')
    const to = result.kind === 'moved' ? result.to : ''
    expect(to.startsWith(`${ORIGIN}/machines/pi?tab=talk#yantra-carry=`)).toBe(true)
    expect(here.replace).toHaveBeenCalledExactlyOnceWith(to)
    expect(asked).toHaveBeenCalledWith(`${ORIGIN}/healthz`, expect.objectContaining({ mode: 'no-cors' }))

    const there = landing(new URL(to).hash)
    expect(arrive(there)).toEqual({ kind: 'arrived', kept: 0 })
    expect(there.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/machines/pi?tab=talk#mic')
  })

  it('takes the drafts and prefs along and leaves none behind', async () => {
    stub(served(ORIGIN), answers)
    const draft = 'half a sentence, with a # and a % in it'
    const here = page(false, {
      'yantra.chat.draft.t-1': draft,
      'yantra.prefs': '{"v":1,"theme":"dark"}',
      'someone.else': 'stays',
    })
    const result = await toSecure(here)
    expect(result).toMatchObject({ kind: 'moved', carried: 2 })
    expect([...here.held.keys()]).toEqual(['someone.else'])

    const there = landing(new URL(result.kind === 'moved' ? result.to : '').hash)
    expect(arrive(there)).toEqual({ kind: 'arrived', kept: 2 })
    expect(there.held.get('yantra.chat.draft.t-1')).toBe(draft)
    expect(there.held.get('yantra.prefs')).toBe('{"v":1,"theme":"dark"}')
    expect(there.held.has('someone.else')).toBe(false)
  })

  it('stays when the daemon names no HTTPS origin', async () => {
    const asked = stub(served(null), answers)
    const here = page()
    expect(await toSecure(here)).toEqual({ kind: 'no-origin' })
    expect(asked).toHaveBeenCalledTimes(1)
    expect(here.replace).not.toHaveBeenCalled()
  })

  it.each([
    ['rejects', () => Promise.reject(new TypeError('Failed to fetch')), 'network'],
    ['answers 500', () => Promise.resolve(answer(500, 'broken')), 'refused'],
    ['answers without the field', () => Promise.resolve(answer(200, { version: '0.1.0' })), 'contract'],
  ])('stays when /api/about %s', async (_, failing, kind) => {
    stub(failing, answers)
    const here = page()
    const result = await toSecure(here)
    expect(result.kind).toBe('about-failed')
    expect(result.kind === 'about-failed' && result.error.kind).toBe(kind)
    expect(here.replace).not.toHaveBeenCalled()
  })

  it('stays when the HTTPS origin does not answer', async () => {
    stub(served(ORIGIN), () => Promise.reject(new TypeError('Failed to fetch')))
    const here = page()
    expect(await toSecure(here)).toEqual({ kind: 'unreachable' })
    expect(here.replace).not.toHaveBeenCalled()
  })

  it('stays when the HTTPS origin does not answer in time', async () => {
    const hangs = (init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      )
    stub(served(ORIGIN), hangs)
    const here = page()
    expect(await toSecure(here, 10)).toEqual({ kind: 'unreachable' })
    expect(here.replace).not.toHaveBeenCalled()
  })
})

const carried = (body: unknown) => `#yantra-carry=${encodeURIComponent(JSON.stringify(body))}`

describe('arrive', () => {
  it('does nothing on a page that carries nothing', () => {
    const there = landing('#mic')
    expect(arrive(there)).toEqual({ kind: 'none' })
    expect(there.replaceState).not.toHaveBeenCalled()
  })

  it('keeps what this origin already holds and writes only yantra keys', () => {
    const there = landing(
      carried({ hash: '', kept: { 'yantra.chat.draft.t-1': 'old', 'yantra.editor': 'zed', other: 'x' } }),
      { 'yantra.chat.draft.t-1': 'typed here' },
    )
    expect(arrive(there)).toEqual({ kind: 'arrived', kept: 1 })
    expect(there.held.get('yantra.chat.draft.t-1')).toBe('typed here')
    expect(there.held.get('yantra.editor')).toBe('zed')
    expect(there.held.has('other')).toBe(false)
    expect(there.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/machines/pi?tab=talk')
  })

  it.each([
    ['is not JSON', '#yantra-carry=%7Bnot'],
    ['is not a carry', carried({ kept: { 'yantra.editor': 1 } })],
    ['breaks its encoding', '#yantra-carry=%E0%A4%A'],
  ])('drops a payload that %s and still clears the address', (_, hash) => {
    const there = landing(hash)
    expect(arrive(there)).toEqual({ kind: 'unreadable' })
    expect(there.held.size).toBe(0)
    expect(there.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/machines/pi?tab=talk')
  })

  it('starts with what it has when the store refuses writes', () => {
    const there = landing(carried({ hash: '', kept: { 'yantra.editor': 'zed' } }))
    there.localStorage.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    expect(arrive(there)).toEqual({ kind: 'arrived', kept: 0 })
  })
})

describe('boot', () => {
  const land = () => ({ kind: 'none' }) as const

  it('does not render a page that moves', async () => {
    const render = vi.fn()
    const moved: Secure = { kind: 'moved', to: ORIGIN, carried: 0 }
    expect(await boot(render, () => Promise.resolve(moved), land)).toEqual(moved)
    expect(render).not.toHaveBeenCalled()
  })

  it('renders a page that stays, after the carry has landed', async () => {
    const order: string[] = []
    const render = vi.fn(() => order.push('render'))
    const stays = () => {
      order.push('move')
      return Promise.resolve({ kind: 'unreachable' } as const)
    }
    await boot(render, stays, () => {
      order.push('land')
      return { kind: 'none' }
    })
    expect(order).toEqual(['land', 'move', 'render'])
  })

  it('renders even when the move throws', async () => {
    const render = vi.fn()
    await expect(boot(render, () => Promise.reject(new Error('boom')), land)).rejects.toThrow('boom')
    expect(render).toHaveBeenCalledOnce()
  })
})
