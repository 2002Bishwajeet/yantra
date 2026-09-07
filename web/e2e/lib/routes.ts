/** Every route in `src/router.ts`, with a path the fixture answers and the
 *  row that owns the screen. The states sweep walks this list; a later spec
 *  that needs one route takes it from here rather than restating the path. */
export type Route = {
  id: string
  path: string
  /** The `<h1>` the route draws (`router.test.tsx`). */
  heading: string
  owner: string
}

export const ROUTES = [
  { id: 'dashboard', path: '/', heading: 'Dashboard', owner: 'Y-346' },
  { id: 'fleet', path: '/fleet', heading: 'Fleet', owner: 'Y-347' },
  { id: 'machines', path: '/machines', heading: 'Machines', owner: 'Y-347' },
  { id: 'machine', path: '/m/cachyos-g14', heading: 'cachyos-g14', owner: 'Y-347' },
  {
    id: 'session-terminal',
    path: '/m/cachyos-g14/s/scratch',
    heading: 'scratch on cachyos-g14',
    owner: 'Y-348',
  },
  { id: 'usage', path: '/usage', heading: 'Usage', owner: 'Y-347' },
  { id: 'session', path: '/w/landing', heading: 'landing', owner: 'Y-348' },
  // `price-table` is the workspace the `repair` scenario breaks; on every
  // other scenario the route answers the refusal for a file that loads.
  { id: 'repair', path: '/w/price-table/repair', heading: 'Repair price-table', owner: 'Y-351' },
  { id: 'new', path: '/new', heading: 'New session', owner: 'Y-349' },
  { id: 'settings', path: '/settings', heading: 'Settings', owner: 'Y-350' },
  { id: 'settings-category', path: '/settings/about', heading: 'Settings', owner: 'Y-350' },
  { id: 'notifications', path: '/notifications', heading: 'Notifications', owner: 'Y-345' },
] as const satisfies readonly Route[]

export type RouteId = (typeof ROUTES)[number]['id']

export const route = (id: RouteId) => ROUTES.find((one) => one.id === id)!
