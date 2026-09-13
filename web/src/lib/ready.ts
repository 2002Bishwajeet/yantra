import type { Check, Readiness } from '@/api'
import { CHECK_IDS, sessionNeeds } from '@/lib/checks'

/** The checks a session needs on a machine, from the one check table
 *  (coordinator's ruling by the owner's delegation, 2026-09-13). GitHub and
 *  `yantra-agent` are optional, so `provider-cli`, `provider-auth` and
 *  `heartbeat` never hold ready back. */
export const READY: readonly string[] = CHECK_IDS.filter(sessionNeeds)

const unasked = (check: string): Check => ({ check, state: 'unknown', detail: '' })

/** The checks a session needs that the report does not show present. A check
 *  the report does not carry was not asked, so it counts as unknown. */
export const blocking = (report: Readiness | null): Check[] =>
  READY.map((name) => report?.checks.find((one) => one.check === name) ?? unasked(name)).filter(
    (one) => one.state !== 'present',
  )

/** The home gate and Add a device's beat 4 both ask this, so they cannot
 *  disagree about one machine. */
export const isReady = (report: Readiness | null) => report !== null && blocking(report).length === 0
