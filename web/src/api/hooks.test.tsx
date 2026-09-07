import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, waitFor } from '@testing-library/react'
import { renderHookQueried } from '../test/inQuery'
import { looked } from './fixtures'
import { useMachines } from './hooks'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Moved from `dashboard.test.tsx`'s `useLooked` suite (Y-341): the hook is
 *  now `useMachines`, and what it owes the page is unchanged. */
describe('a swept reading', () => {
  it('maps a rejected fetch into a failed look rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('daemon is not running'))),
    )
    const { result } = renderHookQueried(() => useMachines())

    await waitFor(() => expect(result.current.looked).toBe('failed'))
    expect(result.current).toMatchObject({
      looked: 'failed',
      error: expect.stringContaining('daemon is not running'),
    })
  })

  it('maps a non-200 into a failed look, since the fleet answers 200 either way', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 404 })),
    )
    const { result } = renderHookQueried(() => useMachines())

    await waitFor(() => expect(result.current.looked).toBe('failed'))
    expect(result.current).toMatchObject({ error: expect.stringContaining('404') })
  })

  /** D3 §7.1. This asserted the bug: a question not yet asked is not a question
   *  answered *never*, and `never` is the daemon's word for having looked at
   *  nothing — not the browser's for not having asked. Y-190. */
  it('answers pending before the first response, and never says never', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(looked.ok([])),
        }),
      ),
    )
    const { result } = renderHookQueried(() => useMachines())
    expect(result.current).toEqual({ looked: 'pending' })
  })

  it('asks the path the daemon serves the class on', async () => {
    const asked = vi.fn((_path: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(looked.ok([], 4)),
      }),
    )
    vi.stubGlobal('fetch', asked)
    const { result } = renderHookQueried(() => useMachines())

    await waitFor(() => expect(result.current.looked).toBe('ok'))
    expect(asked.mock.calls[0]![0]).toBe('/api/machines')
    expect(result.current).toMatchObject({ age_seconds: 4, data: [] })
  })
})
