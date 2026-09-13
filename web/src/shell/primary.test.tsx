import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from 'react-error-boundary'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { PrimaryAction } from './PrimaryAction'
import {
  keyOf,
  useFab,
  usePrimary,
  usePublishDrawn,
  usePublishRoute,
  useRouteAction,
  type Primary,
  type RoutePrimary,
} from './primary'

/* The store behind the FAB, without the shell: who wins, and what an error
   page leaves behind. `Shell.test.tsx` asserts what each route draws. */

function Probe() {
  return <output>{keyOf(usePrimary())}</output>
}

function Route({ kind }: { kind: RoutePrimary | null }) {
  usePublishRoute(kind)
  return null
}

const shown = () => screen.getByRole('status').textContent

describe('the page’s one action', () => {
  it('is the route’s own while no screen says otherwise', () => {
    render(
      <>
        <Route kind="add-device" />
        <Probe />
      </>,
    )
    expect(shown()).toBe('add-device')
  })

  it('is the screen’s once it claims one, and the route’s again when it goes', () => {
    const { rerender } = render(
      <>
        <Route kind="new-session" />
        <PrimaryAction action={{ kind: 'add-device' }} />
        <Probe />
      </>,
    )
    expect(shown()).toBe('add-device')
    rerender(
      <>
        <Route kind="new-session" />
        <Probe />
      </>,
    )
    expect(shown()).toBe('new-session')
  })

  it('is none when the screen says it has none, whatever the route declares', () => {
    render(
      <>
        <Route kind="new-session" />
        <PrimaryAction action={null} />
        <Probe />
      </>,
    )
    expect(shown()).toBe('none')
  })

  it('is the newest claim, and the older one again when the newest goes', () => {
    function Two() {
      const [late, setLate] = useState(false)
      return (
        <>
          <PrimaryAction action={{ kind: 'add-device' }} />
          {late ? <PrimaryAction action={{ kind: 'new-session' }} /> : null}
          <button onClick={() => setLate((was) => !was)}>toggle</button>
          <Probe />
        </>
      )
    }
    render(<Two />)
    expect(shown()).toBe('add-device')
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    expect(shown()).toBe('new-session')
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    expect(shown()).toBe('add-device')
  })

  /** A new function each render is the same claim, and a press reaches the
   *  newest one — the setup line's `install.press` is rebuilt every render. */
  it('presses the newest handler without re-claiming', () => {
    const first = vi.fn()
    const second = vi.fn()
    function Press() {
      const action = usePrimary()
      return <button onClick={() => action?.kind === 'install' && action.press()}>press</button>
    }
    const install = (press: () => void): Primary => ({ kind: 'install', machine: 'pi-5', press })
    const { rerender } = render(
      <>
        <PrimaryAction action={install(first)} />
        <Press />
      </>,
    )
    rerender(
      <>
        <PrimaryAction action={install(second)} />
        <Press />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'press' }))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  /** D7 §3.6: an error page carries none. The shell publishes the route's
   *  action from inside the page's boundary, so a throw takes it away too. */
  it('is none once the page under the boundary throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    function Breaks({ broken }: { broken: boolean }) {
      if (broken) throw new Error('drawn wrong')
      return <PrimaryAction action={{ kind: 'add-device' }} />
    }
    const page = (broken: boolean) => (
      <>
        <ErrorBoundary fallback={<p>broke</p>}>
          <Route kind="new-session" />
          <Breaks broken={broken} />
        </ErrorBoundary>
        <Probe />
      </>
    )
    const { rerender } = render(page(false))
    expect(shown()).toBe('add-device')
    rerender(page(true))
    expect(screen.getByText('broke')).toBeTruthy()
    expect(shown()).toBe('none')
    vi.restoreAllMocks()
  })
})

describe('the route’s declared action', () => {
  function Root() {
    const kind = useRouteAction()
    return (
      <>
        <output>{kind ?? 'none'}</output>
        <Outlet />
      </>
    )
  }

  async function at(loader?: () => void) {
    const root = createRootRoute({ component: Root })
    const page = createRoute({
      getParentRoute: () => root,
      path: '/',
      staticData: { primary: 'add-device' },
      loader,
      component: () => <p>page</p>,
      errorComponent: () => <p>error page</p>,
    })
    const router = createRouter({ routeTree: root.addChildren([page]), history: createMemoryHistory() })
    await act(() => router.load())
    render(<RouterProvider router={router} />)
  }

  it('is read off the route’s staticData', async () => {
    await at()
    expect(await screen.findByText('page')).toBeTruthy()
    expect(shown()).toBe('add-device')
  })

  it('is none on a route whose load failed', async () => {
    await at(() => {
      throw new Error('the loader failed')
    })
    expect(await screen.findByText('error page')).toBeTruthy()
    expect(shown()).toBe('none')
  })
})

describe('what a screen is told', () => {
  it('is nothing until the shell draws the FAB, then the action it carries', () => {
    function Screen() {
      return <output>{keyOf(useFab())}</output>
    }
    function Shell({ draws }: { draws: boolean }) {
      usePublishDrawn(draws)
      return null
    }
    const { rerender } = render(
      <>
        <PrimaryAction action={{ kind: 'add-device' }} />
        <Shell draws={false} />
        <Screen />
      </>,
    )
    expect(shown()).toBe('none')
    rerender(
      <>
        <PrimaryAction action={{ kind: 'add-device' }} />
        <Shell draws />
        <Screen />
      </>,
    )
    expect(shown()).toBe('add-device')
  })
})
