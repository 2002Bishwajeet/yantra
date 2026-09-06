import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ApiError, type Kind } from '@/api/errors'
import { ErrorBoundary, RouteError } from './ErrorBoundary'

afterEach(cleanup)

/** The boundary reads Query and the router, so the test supplies both. */
async function mount(ui: ReactNode) {
  const root = createRootRoute({ component: () => ui })
  const router = createRouter({ routeTree: root, history: createMemoryHistory() })
  await router.load()
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function Throws(props: { error: unknown; until?: { ok: boolean } }) {
  if (!props.until?.ok) throw props.error
  return <p>drawn after all</p>
}

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})

describe('ErrorBoundary', () => {
  it('draws the fallback as an alert, focuses the title, and Try again re-renders the children', async () => {
    quiet()
    const until = { ok: false }
    await mount(
      <ErrorBoundary title="Fleet could not be read">
        <Throws error={new ApiError('network', 'fetch failed')} until={until} />
      </ErrorBoundary>,
    )
    const alert = await screen.findByRole('alert')
    expect(alert.dataset.layout).toBe('card')
    const title = screen.getByRole('heading', { name: 'Fleet could not be read' })
    expect(document.activeElement).toBe(title)
    expect(screen.getByText('The daemon did not answer.')).toBeTruthy()
    until.ok = true
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('drawn after all')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each<[Kind, string]>([
    ['network', 'The daemon did not answer.'],
    ['refused', 'The daemon refused.'],
    ['missing', 'The daemon knows nothing by that name.'],
    ['contract', 'The daemon answered something this dashboard cannot read.'],
    ['socket', 'The terminal could not be opened.'],
  ])('draws describe() for a thrown %s error', async (kind, sentence) => {
    quiet()
    await mount(
      <ErrorBoundary layout="inline">
        <Throws error={new ApiError(kind, 'said so')} />
      </ErrorBoundary>,
    )
    expect(await screen.findByText(sentence)).toBeTruthy()
    expect(screen.getByText('said so')).toBeTruthy()
  })

  it('names a bare error and nothing more', async () => {
    quiet()
    await mount(
      <ErrorBoundary layout="page">
        <Throws error={new RangeError('x is not iterable at Fleet.tsx:12')} />
      </ErrorBoundary>,
    )
    expect(await screen.findByText('Something in this part of the page broke.')).toBeTruthy()
    expect(screen.getByText('RangeError')).toBeTruthy()
    expect(screen.queryByText(/Fleet\.tsx/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('resets when a key changes', async () => {
    quiet()
    const until = { ok: false }
    const error = new ApiError('network', 'fetch failed')
    const view = await mount(
      <ErrorBoundary resetKeys={['one']}>
        <Throws error={error} until={until} />
      </ErrorBoundary>,
    )
    await screen.findByRole('alert')
    until.ok = true
    const root = createRootRoute({
      component: () => (
        <ErrorBoundary resetKeys={['two']}>
          <Throws error={error} until={until} />
        </ErrorBoundary>
      ),
    })
    const router = createRouter({ routeTree: root, history: createMemoryHistory() })
    await router.load()
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    expect(await screen.findByText('drawn after all')).toBeTruthy()
  })

  it('has a route-shaped export', async () => {
    await mount(<RouteError error={new ApiError('missing', 'no such workspace')} reset={() => {}} />)
    const alert = await screen.findByRole('alert')
    expect(alert.dataset.layout).toBe('page')
    expect(screen.getByText('The daemon knows nothing by that name.')).toBeTruthy()
  })
})
