/** Y-678: a route change runs one view transition, typed by direction; reduce runs none. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryHistory } from '@tanstack/react-router'
import App from './App'
import { makeQueryClient } from '@/api/client'
import { getRouter, transitionTypes } from './router'

const at = (pathname: string, index: number) => ({ pathname, state: { __TSR_index: index } })

let reduce = false
let calls: string[][]

beforeEach(() => {
  reduce = false
  calls = []
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduce : query.includes('min-width: 1240px'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
  vi.stubGlobal('CSS', { supports: () => true, escape: (s: string) => s })
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ looked: 'never' }) }),
    ),
  )
  Object.assign(document, {
    startViewTransition: (arg: unknown) => {
      const { update, types } = arg as { update: () => void; types?: string[] }
      calls.push(types ?? [])
      update()
      return { updateCallbackDone: Promise.resolve(), finished: Promise.resolve(), ready: Promise.resolve() }
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'startViewTransition')
})

describe('transitionTypes', () => {
  it('pushes forward', () => {
    expect(transitionTypes({ fromLocation: at('/', 0), toLocation: at('/machines', 1) })).toEqual(['forward'])
  })
  it('goes back to a lower history index', () => {
    expect(transitionTypes({ fromLocation: at('/machines', 1), toLocation: at('/', 0) })).toEqual(['back'])
  })
  it('does not animate a search change on the same path', () => {
    expect(transitionTypes({ fromLocation: at('/usage', 1), toLocation: at('/usage', 2) })).toBe(false)
  })
  it('does not animate under reduce', () => {
    reduce = true
    expect(transitionTypes({ fromLocation: at('/', 0), toLocation: at('/machines', 1) })).toBe(false)
  })
})

describe('a route change in the router', () => {
  const mount = () => {
    const history = createMemoryHistory({ initialEntries: ['/'] })
    const router = getRouter(history, makeQueryClient())
    render(<App router={router} />)
    return { history, router }
  }
  const h1 = (name: string) => screen.findByRole('heading', { level: 1, name })

  it('runs one typed transition per navigation', async () => {
    const { history, router } = mount()
    await h1('Dashboard')
    await router.navigate({ to: '/machines' })
    await h1('Machines')
    await router.navigate({ to: '/m/$machine', params: { machine: 'pi-5' } })
    await h1('pi-5')
    history.back()
    await h1('Machines')
    expect(calls.map((c) => c[0])).toEqual(['forward', 'forward', 'back'])
  })

  it('runs none under reduce and still changes the screen', async () => {
    reduce = true
    const { router } = mount()
    await h1('Dashboard')
    await router.navigate({ to: '/machines' })
    await h1('Machines')
    expect(calls).toHaveLength(0)
  })
})
