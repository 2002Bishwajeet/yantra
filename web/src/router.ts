import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouterHistory,
} from '@tanstack/react-router'
import { Fleet } from '@/routes/Fleet'
import { Machines } from '@/routes/Machines'
import { OneMachine } from '@/routes/OneMachine'
import { Nowhere, Shell } from '@/routes/Shell'
import { asView, type View } from '@/views'

/** A phone's app switcher shows the front of the title, so the route's own name
 *  goes first — every route was `Yantra` before Y-187. */
const titled = (name: string) => ({ meta: [{ title: `${name} · Yantra` }] })

const root = createRootRoute({
  component: Shell,
  notFoundComponent: Nowhere,
  head: () => titled('Nowhere'),
})

const fleet = createRoute({
  getParentRoute: () => root,
  path: '/',
  component: Fleet,
  head: () => titled('Fleet'),
})

const machines = createRoute({
  getParentRoute: () => root,
  path: '/machines',
  component: Machines,
  head: () => titled('Machines'),
})

// Split with `/w/$name` rather than eager with the fleet: the two forms carry
// Base UI's `field` between them, and D3 §9.1's budget has no room for a form
// nobody has opened (Y-194).
const made = createRoute({
  getParentRoute: () => root,
  path: '/new',
  component: lazyRouteComponent(() => import('@/routes/New'), 'New'),
  head: () => titled('New workspace'),
})

// Split for `/new`'s reason and no other: it is the third form, and `ui/field`
// has no business on the first paint of a page nobody opens twice a year.
const settings = createRoute({
  getParentRoute: () => root,
  path: '/settings',
  component: lazyRouteComponent(() => import('@/routes/Settings'), 'Settings'),
  head: () => titled('Settings'),
})

// Split, and it is the only one of the four eager routes that pays: measured at
// 2.18 kB gzip off the first load, against `/machines` and `/m/$name`, which
// cost more than they save for Y-197's reason (Y-194).
const usage = createRoute({
  getParentRoute: () => root,
  path: '/usage',
  component: lazyRouteComponent(() => import('@/routes/Usage'), 'Usage'),
  head: () => titled('Usage'),
})

// `$machine` and `$name` are what make `<Link to="/m/$machine" params>` refuse a
// typo at compile time, which is the whole reason these are not strings.
const machine = createRoute({
  getParentRoute: () => root,
  path: '/m/$machine',
  component: OneMachine,
  head: ({ params }) => titled(params.machine),
})

// Split for the same reason as `/w/$name`, and it is the reason this is a route
// at all: `/machines` is eager, and a terminal drawn in its own ACT column would
// put xterm.js on the first load of a page that attaches to nothing (ADR-0022).
const session = createRoute({
  getParentRoute: () => root,
  path: '/m/$machine/s/$session',
  component: lazyRouteComponent(
    () => import('@/routes/OneSession'),
    'OneSession',
  ),
  head: ({ params }) => titled(`${params.session} on ${params.machine}`),
})

// Split for the heaviest reason of any of them: xterm.js and its CSS are a
// third of the bundle, and the fleet does not use them.
const workspace = createRoute({
  getParentRoute: () => root,
  path: '/w/$name',
  // D5 §3.3. The key is always written, because the root validates nothing and
  // an unknown `?view=` would otherwise reach the page by inheritance; the type
  // stays optional, so every existing link here still needs no search.
  validateSearch: (search: Record<string, unknown>): { view?: View } => ({
    view: asView(search.view),
  }),
  component: lazyRouteComponent(
    () => import('@/routes/OneWorkspace'),
    'OneWorkspace',
  ),
  head: ({ params }) => titled(params.name),
})

// Split for `made`'s reason and one of its own: it draws the file as text,
// which is the one surface no workspace that works ever opens (D3 §7.5).
const repair = createRoute({
  getParentRoute: () => root,
  path: '/w/$name/repair',
  component: lazyRouteComponent(() => import('@/routes/Repair'), 'Repair'),
  head: ({ params }) => titled(`Repair ${params.name}`),
})

export const routeTree = root.addChildren([
  fleet,
  machines,
  made,
  settings,
  usage,
  machine,
  session,
  workspace,
  repair,
])

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
