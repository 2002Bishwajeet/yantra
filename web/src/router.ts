import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouterHistory,
} from '@tanstack/react-router'
import { Fleet } from '@/routes/Fleet'
import { OneMachine } from '@/routes/OneMachine'
import { Nowhere, Shell } from '@/routes/Shell'

const root = createRootRoute({ component: Shell, notFoundComponent: Nowhere })

const fleet = createRoute({
  getParentRoute: () => root,
  path: '/',
  component: Fleet,
})

// `$machine` and `$name` are what make `<Link to="/m/$machine" params>` refuse a
// typo at compile time, which is the whole reason these are not strings.
const machine = createRoute({
  getParentRoute: () => root,
  path: '/m/$machine',
  component: OneMachine,
})

// The only split route, and it is split for one reason: xterm.js and its CSS
// are a third of the bundle, and the fleet does not use them.
const workspace = createRoute({
  getParentRoute: () => root,
  path: '/w/$name',
  component: lazyRouteComponent(
    () => import('@/routes/OneWorkspace'),
    'OneWorkspace',
  ),
})

export const routeTree = root.addChildren([fleet, machine, workspace])

/** The history is a parameter rather than a default, which is
 *  [T3 Code](https://github.com/pingdotgg/t3code)'s `getRouter` shape: it is
 *  what lets a test drive a memory history and the entry point drive the
 *  browser's, with no branch inside. */
export function getRouter(history: RouterHistory) {
  return createRouter({ routeTree, history })
}

export type AppRouter = ReturnType<typeof getRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}
