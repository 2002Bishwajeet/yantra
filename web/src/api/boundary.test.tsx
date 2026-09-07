/**
 * The reset path: a route under `ErrorBoundary` whose read threw, and a
 * navigation that has to clear both the boundary and Query's own error — or
 * the next page opens on the last page's failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { answer } from '../test/daemon'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { makeQueryClient, queryOptionsThrowing } from './client'
import { asApiError } from './errors'
import { useResetOnRouteChange } from './hooks'
import { aboutQuery } from './queries'

afterEach(() => vi.unstubAllGlobals())

/** What the Packages agent's `ErrorSurface` reads: one shape, one sentence. */
function Fallback({ error }: FallbackProps) {
  const said = asApiError(error)
  return (
    <div role="alert">
      {said.describe()} <code>{said.said}</code> ({said.kind})
    </div>
  )
}

function Shell() {
  return (
    <ErrorBoundary FallbackComponent={Fallback} {...useResetOnRouteChange()}>
      <Outlet />
    </ErrorBoundary>
  )
}

function About() {
  const { data } = useQuery(queryOptionsThrowing(aboutQuery()))
  return <p>version {data?.version ?? 'reading'}</p>
}

function open() {
  const root = createRootRoute({ component: Shell })
  const about = createRoute({ getParentRoute: () => root, path: '/', component: About })
  const other = createRoute({
    getParentRoute: () => root,
    path: '/other',
    component: () => <p>elsewhere</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([about, other]),
    history: createMemoryHistory(),
  })
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('a route under an error boundary', () => {
  it('shows the typed error, and a navigation clears it and asks again', async () => {
    let refusing = true
    const asked = vi.fn(() =>
      Promise.resolve(
        refusing
          ? answer(503, 'could not establish who is calling')
          : answer(200, { version: '0.9.0', uptime_seconds: 1, listening_on: [] }),
      ),
    )
    vi.stubGlobal('fetch', asked)
    const router = open()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('nothing was decided')
    expect(alert.textContent).toContain('could not establish who is calling')
    expect(alert.textContent).toContain('(refused)')
    expect(asked).toHaveBeenCalledTimes(1)

    await act(() => router.history.push('/other'))
    expect(await screen.findByText('elsewhere')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()

    refusing = false
    await act(() => router.history.push('/'))
    expect(await screen.findByText('version 0.9.0')).toBeTruthy()
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(2))
  })

  it('holds the error in place when the options do not throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve('no such route'),
        }),
      ),
    )
    function Held() {
      const { error } = useQuery(aboutQuery())
      return <p>{error ? asApiError(error).describe() : 'reading'}</p>
    }
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <Held />
      </QueryClientProvider>,
    )

    expect(
      await screen.findByText('The daemon knows nothing by that name.'),
    ).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
