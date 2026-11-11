import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { homeOpened, machineThreads } from '@/contract.gen'
import { daemon } from '../test/daemon'
import { renderHookQueried } from '../test/inQuery'
import { aMachine, looked } from './fixtures'
import { ApiError } from './errors'
import { keys } from './keys'
import { useRemoveHomeThread } from './mutations'
import { machineThreadsQuery, useHomeThreads, useMachineHomeThreads } from './queries'

afterEach(() => vi.unstubAllGlobals())

const paths = (asked: ReturnType<typeof daemon>) => asked.mock.calls.map((call) => call[0])

describe('the machine threads query', () => {
  it('is a GET of the machine route that never polls', async () => {
    const asked = daemon(200, machineThreads)
    const options = machineThreadsQuery('mac book')
    expect(options.queryKey).toEqual(keys.machineThreads('mac book'))
    expect(options.refetchInterval).toBeUndefined()
    const { result } = renderHookQueried(() => useMachineHomeThreads('mac book'))
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(paths(asked)).toEqual(['/api/machines/mac%20book/threads'])
    expect(asked.mock.calls[0][1]?.method).toBeUndefined()
    // The workspace row is the workspace's; only the home row stays.
    expect(result.current.data?.map((one) => one.title)).toEqual(['Say hello'])
  })

  it.each([
    [403, 'not on the tailnet'],
    [404, 'no such machine'],
    [503, 'the store is not open'],
  ])('rejects %i with the status and the words', async (status, said) => {
    daemon(status, said)
    const { result } = renderHookQueried(() => useMachineHomeThreads('mac'))
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect(result.current.error).toMatchObject({ status, said })
  })
})

describe('every machine home threads', () => {
  const wrap = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  }

  it('reads each machine the list names and keeps the home rows with their machine', async () => {
    const asked = vi.fn((path: string) =>
      Promise.resolve(
        path === '/api/machines'
          ? new Response(JSON.stringify(looked.ok([aMachine({ name: 'mac' }), aMachine({ name: 'box' })])))
          : new Response(JSON.stringify(machineThreads)),
      ),
    )
    vi.stubGlobal('fetch', asked)
    const { result } = renderHook(() => useHomeThreads(), { wrapper: wrap() })
    expect(result.current.state).toBe('pending')
    await waitFor(() => expect(result.current.state).toBe('ok'))
    if (result.current.state !== 'ok') return
    expect(result.current.threads.map((one) => one.machine)).toEqual(['mac', 'box'])
    expect(result.current.threads.every((one) => one.thread.workspace === null)).toBe(true)
  })

  it('fails with the daemon words when one machine cannot be read, and retry asks again', async () => {
    let refusing = true
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) =>
        Promise.resolve(
          path === '/api/machines'
            ? new Response(JSON.stringify(looked.ok([aMachine({ name: 'mac' })])))
            : refusing
              ? new Response('the store is not open', { status: 503 })
              : new Response(JSON.stringify(machineThreads)),
        ),
      ),
    )
    const { result } = renderHook(() => useHomeThreads(), { wrapper: wrap() })
    await waitFor(() => expect(result.current.state).toBe('failed'))
    if (result.current.state !== 'failed') return
    expect(result.current.error).toMatchObject({ status: 503, said: 'the store is not open' })
    refusing = false
    act(() => result.current.state === 'failed' && result.current.retry())
    await waitFor(() => expect(result.current.state).toBe('ok'))
  })

  it('draws nothing of its own when the machine list failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ looked: 'failed', age_seconds: 0, error: 'sweep broke' })))),
    )
    const { result } = renderHook(() => useHomeThreads(), { wrapper: wrap() })
    await waitFor(() => expect(result.current.state).toBe('unknown'))
  })
})

describe('removing a home thread', () => {
  it('is a DELETE of the thread under its machine', async () => {
    const asked = daemon(204)
    const { result } = renderHookQueried(() => useRemoveHomeThread('mac book'))
    await act(() => result.current.mutateAsync(homeOpened.thread))
    const [path, init] = asked.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(`/api/machines/mac%20book/threads/${homeOpened.thread}`)
    expect(init.method).toBe('DELETE')
  })

  it.each([
    [400, 'not a thread id'],
    [403, 'not on the tailnet'],
    [404, 'mac has no home thread 6a1b'],
    [503, 'mac did not answer'],
  ])('rejects %i with the status and the words', async (status, said) => {
    daemon(status, said)
    const { result } = renderHookQueried(() => useRemoveHomeThread('mac'))
    const error = await act(() => result.current.mutateAsync('6a1b').then(() => null, (cause: unknown) => cause))
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status, said })
  })
})
