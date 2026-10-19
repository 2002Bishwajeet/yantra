import type { About, Machine } from '@/api'

/** The node the daemon runs on: the one whose address it is bound to. The
 *  daemon binds only tailnet addresses, as `api::tailnet` relies on. */
export function appliance(machines: Machine[], about: About | undefined): Machine | null {
  if (!about) return null
  const bound = about.listening_on.map((one) => one.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1'))
  return machines.find((one) => one.address !== null && bound.includes(one.address)) ?? null
}
