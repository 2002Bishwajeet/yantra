import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouterHistory,
} from '@tanstack/react-router'
import {
  attentionQuery,
  machineReadinessQuery,
  machinesQuery,
  readinessQuery,
  sessionsQuery,
  statusQuery,
  workspacesQuery,
} from '@/api/queries'
import { RouteError } from '@/m3/error-boundary/ErrorBoundary'
import { Dashboard } from '@/screens/dashboard/Dashboard'
import { Nowhere, Shell } from '@/shell/Shell'
import { asView, type View } from '@/views'

/** A phone's app switcher shows the front of the title, so the route's own name
 *  goes first — every route was `Yantra` before Y-187. */
const titled = (name: string) => ({ meta: [{ title: `${name} · Yantra` }] })

type Context = { client: QueryClient }

/** A loader warms the reads its screen draws, so a hover starts them
 *  (`defaultPreload: 'intent'`). Not awaited: the screen draws its own
 *  skeleton while a look is out, and awaiting would hold the whole page on it.
 *  Only swept classes: `look` never throws, so a failed read is data the
 *  screen draws rather than an error the route shows. */

const root = createRootRouteWithContext<Context>()({
  component: Shell,
  notFoundComponent: Nowhere,
  head: () => titled('Nowhere'),
})

// The one eager route: everything else arrives with its chunk (ADR-0024 §3).
const dashboard = createRoute({
  getParentRoute: () => root,
  path: '/',
  component: Dashboard,
  loader: ({ context: { client } }) => {
    void client.ensureQueryData(workspacesQuery())
    void client.ensureQueryData(machinesQuery())
    void client.ensureQueryData(sessionsQuery())
    void client.ensureQueryData(attentionQuery())
  },
  head: () => titled('Dashboard'),
})

const fleet = createRoute({
  getParentRoute: () => root,
  path: '/fleet',
  component: lazyRouteComponent(() => import('@/screens/fleet/Fleet'), 'Fleet'),
  loader: ({ context: { client } }) => {
    void client.ensureQueryData(workspacesQuery())
    void client.ensureQueryData(machinesQuery())
    void client.ensureQueryData(sessionsQuery())
    void client.ensureQueryData(attentionQuery())
  },
  head: () => titled('Fleet'),
})

const machines = createRoute({
  getParentRoute: () => root,
  path: '/machines',
  component: lazyRouteComponent(() => import('@/screens/machines/Machines'), 'Machines'),
  loader: ({ context: { client } }) => {
    void client.ensureQueryData(machinesQuery())
    void client.ensureQueryData(readinessQuery())
    void client.ensureQueryData(sessionsQuery())
  },
  head: () => titled('Machines'),
})

// `$machine` and `$name` are what make `<Link to="/m/$machine" params>` refuse a
// typo at compile time, which is the whole reason these are not strings.
const machine = createRoute({
  getParentRoute: () => root,
  path: '/m/$machine',
  component: lazyRouteComponent(() => import('@/screens/machine/Machine'), 'Machine'),
  loader: ({ context: { client }, params }) => {
    void client.ensureQueryData(machinesQuery())
    void client.ensureQueryData(machineReadinessQuery(params.machine))
    void client.ensureQueryData(sessionsQuery())
    void client.ensureQueryData(workspacesQuery())
  },
  head: ({ params }) => titled(params.machine),
})

// A terminal for any tmux session, claimed by a workspace or not (ADR-0022).
const sessionTerminal = createRoute({
  getParentRoute: () => root,
  path: '/m/$machine/s/$session',
  component: lazyRouteComponent(
    () => import('@/screens/session-terminal/SessionTerminal'),
    'SessionTerminal',
  ),
  loader: ({ context: { client } }) => {
    void client.ensureQueryData(sessionsQuery())
  },
  head: ({ params }) => titled(`${params.session} on ${params.machine}`),
})

const usage = createRoute({
  getParentRoute: () => root,
  path: '/usage',
  component: lazyRouteComponent(() => import('@/screens/usage/Usage'), 'Usage'),
  loader: ({ context: { client } }) => {
    void client.ensureQueryData(workspacesQuery())
  },
  head: () => titled('Usage'),
})

const session = createRoute({
  getParentRoute: () => root,
  path: '/w/$name',
  // D5 §3.3. The key is always written, because the root validates nothing and
  // an unknown `?view=` would otherwise reach the page by inheritance; the type
  // stays optional, so every link here still needs no search.
  validateSearch: (search: Record<string, unknown>): { view?: View } => ({
    view: asView(search.view),
  }),
  component: lazyRouteComponent(() => import('@/screens/session/Session'), 'Session'),
  loader: ({ context: { client }, params }) => {
    void client.ensureQueryData(workspacesQuery())
    void client.ensureQueryData(statusQuery(params.name))
  },
  head: ({ params }) => titled(params.name),
})

const repair = createRoute({
  getParentRoute: () => root,
  path: '/w/$name/repair',
  component: lazyRouteComponent(() => import('@/screens/repair/Repair'), 'Repair'),
  head: ({ params }) => titled(`Repair ${params.name}`),
})

const STEPS = [1, 2, 3, 4] as const
export type Step = (typeof STEPS)[number]

const asStep = (given: unknown): Step | undefined =>
  STEPS.find((one) => one === Number(given))

const newSession = createRoute({
  getParentRoute: () => root,
  path: '/new',
  validateSearch: (search: Record<string, unknown>): { step?: Step } => ({
    step: asStep(search.step),
  }),
  component: lazyRouteComponent(
    () => import('@/screens/new-session/NewSession'),
    'NewSession',
  ),
  loader: ({ context: { client } }) => {
    void client.ensureQueryData(machinesQuery())
  },
  head: () => titled('New session'),
})

// Two routes, one screen: `/settings` is the index on a phone and the first
// category beside the list on a desktop; `/settings/$category` is one category.
const settings = createRoute({
  getParentRoute: () => root,
  path: '/settings',
  component: lazyRouteComponent(() => import('@/screens/settings/Settings'), 'Settings'),
  head: () => titled('Settings'),
})

const settingsCategory = createRoute({
  getParentRoute: () => root,
  path: '/settings/$category',
  component: lazyRouteComponent(() => import('@/screens/settings/Settings'), 'Settings'),
  head: ({ params }) => titled(`${params.category} · Settings`),
})

// The phone's pushed notifications screen; the shell's bell links here
// under 600 px and opens a popover or a side sheet above it.
const notifications = createRoute({
  getParentRoute: () => root,
  path: '/notifications',
  component: lazyRouteComponent(
    () => import('@/shell/NotificationsScreen'),
    'NotificationsScreen',
  ),
  loader: ({ context: { client } }) => {
    void client.ensureQueryData(attentionQuery())
  },
  head: () => titled('Notifications'),
})

// Y-339: the component gallery, for the reviewer and Playwright. Dev only;
// the production tree has the route and no chunk behind it.
const gallery = createRoute({
  getParentRoute: () => root,
  path: '/m3',
  component: import.meta.env.DEV
    ? lazyRouteComponent(() => import('@/m3/gallery/Gallery'), 'Gallery')
    : Nowhere,
  head: () => titled('M3 gallery'),
})

export const routeTree = root.addChildren([
  dashboard,
  fleet,
  machines,
  machine,
  sessionTerminal,
  usage,
  session,
  repair,
  newSession,
  settings,
  settingsCategory,
  notifications,
  gallery,
])

/** The history is a parameter rather than a default, which is
 *  [T3 Code](https://github.com/pingdotgg/t3code)'s `getRouter` shape: it is
 *  what lets a test drive a memory history and the entry point drive the
 *  browser's, with no branch inside. The client is the same kind of thing. */
export function getRouter(history: RouterHistory, client: QueryClient) {
  return createRouter({
    routeTree,
    history,
    context: { client },
    defaultPreload: 'intent',
    // Query holds the cache, so the router's own copy of a loader result
    // would only ever be stale.
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: Nowhere,
    scrollRestoration: true,
  })
}

export type AppRouter = ReturnType<typeof getRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}
