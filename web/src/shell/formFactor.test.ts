import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFormFactor } from './formFactor'

type Env = { width: number; height: number; touch: boolean }

function stubMedia(env: Env) {
  const listeners = new Map<string, Set<() => void>>()
  const matches = (q: string) => {
    const min = /min-width: (\d+)px/.exec(q)
    const maxH = /max-height: (\d+)px/.exec(q)
    return (
      (!min || env.width >= Number(min[1])) &&
      (!maxH || env.height <= Number(maxH[1])) &&
      (!q.includes('orientation: landscape') || env.width > env.height) &&
      (!q.includes('pointer: coarse') || env.touch)
    )
  }
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() {
      return matches(q)
    },
    addEventListener: (_: string, fn: () => void) => {
      if (!listeners.has(q)) listeners.set(q, new Set())
      listeners.get(q)!.add(fn)
    },
    removeEventListener: (_: string, fn: () => void) => listeners.get(q)?.delete(fn),
  }))
  return (q: string) => listeners.get(q)?.forEach((fn) => fn())
}

const factor = (env: Env) => {
  stubMedia(env)
  return renderHook(() => useFormFactor()).result.current
}

afterEach(() => vi.unstubAllGlobals())

describe('useFormFactor', () => {
  it.each([
    ['a phone held sideways', { width: 844, height: 390, touch: true }, 'phone'],
    ['a short window with a mouse', { width: 844, height: 390, touch: false }, 'tablet'],
    ['a phone held upright', { width: 390, height: 844, touch: true }, 'phone'],
    ['a tablet', { width: 834, height: 1194, touch: true }, 'tablet'],
    ['a desktop', { width: 1440, height: 1024, touch: false }, 'desktop'],
  ] as const)('gives %s the %s shell', (_, env, expected) => {
    expect(factor(env)).toBe(expected)
  })

  it('switches from tablet to phone when the phone turns sideways', () => {
    const env: Env = { width: 600, height: 844, touch: true }
    const fire = stubMedia(env)
    const { result } = renderHook(() => useFormFactor())
    expect(result.current).toBe('tablet')
    act(() => {
      env.height = 390
      env.width = 844
      fire('(pointer: coarse) and (orientation: landscape) and (max-height: 479px)')
    })
    expect(result.current).toBe('phone')
  })
})
