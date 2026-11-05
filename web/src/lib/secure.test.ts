import { afterEach, describe, expect, it, vi } from 'vitest'
import { about } from '../contract.gen'
import { answer } from '../test/daemon'
import { toSecure, type Page } from './secure'

afterEach(() => vi.unstubAllGlobals())

const ORIGIN = 'https://pi.example.ts.net:8443'

function page(isSecureContext = false): Page & { replace: ReturnType<typeof vi.fn> } {
  const replace = vi.fn()
  return {
    isSecureContext,
    location: { pathname: '/machines/pi', search: '?tab=talk', hash: '#mic', replace },
    replace,
  }
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
    const to = `${ORIGIN}/machines/pi?tab=talk#mic`
    expect(await toSecure(here)).toEqual({ kind: 'moved', to })
    expect(here.replace).toHaveBeenCalledExactlyOnceWith(to)
    expect(asked).toHaveBeenCalledWith(`${ORIGIN}/healthz`, expect.objectContaining({ mode: 'no-cors' }))
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
