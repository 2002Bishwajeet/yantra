import type { Check, Readiness } from '@/api'
import { CHECK_IDS, INSTALLABLE, sessionNeeds } from '@/lib/checks'

/** The checks a session needs on a machine, from the one check table
 *  (coordinator's ruling by the owner's delegation, 2026-09-13). GitHub and
 *  `yantra-agent` are optional, so `provider-cli`, `provider-auth` and
 *  `heartbeat` never hold ready back. */
export const READY: readonly string[] = CHECK_IDS.filter(sessionNeeds)

const unasked = (check: string): Check => ({ check, state: 'unknown', detail: '' })

/** A check the report does not carry was not asked, so it counts as unknown
 *  rather than present — R-23: silence must not read as fine. */
function notPresent(ids: readonly string[], report: Readiness | null): Check[] {
  return ids
    .map((name) => report?.checks.find((one) => one.check === name) ?? unasked(name))
    .filter((one) => one.state !== 'present')
}

/** The checks a session needs that the report does not show present. */
export const blocking = (report: Readiness | null): Check[] => notPresent(READY, report)

/** The Install-fixable basics that are missing or were never asked — the one
 *  answer the machines-list card and the machine page's Readiness card both
 *  read, so they cannot disagree about how many are missing (Y-402 review). */
export const missingBasics = (report: Readiness | null): Check[] => notPresent(INSTALLABLE, report)

/** The home gate and Add a device's beat 4 both ask this, so they cannot
 *  disagree about one machine. */
export const isReady = (report: Readiness | null) => report !== null && blocking(report).length === 0
