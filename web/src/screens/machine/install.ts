import type { Check, Event } from '@/api'
import { nameOf } from '@/lib/checks'

/** ADR-0028 §1's list, by `doctor`'s ids. */
const BASICS = ['tmux', 'git', 'agent-cli']

/** The basics that are absent, by name. `unknown` is never missing: it sends
 *  nobody to install anything (R-23). */
export function missingBasics(checks: Check[]): string[] {
  return BASICS.flatMap((id) =>
    checks.some((one) => one.check === id && one.state === 'absent') ? [nameOf(id)] : [],
  )
}

const isInstall = (event: Event) => event.kind === 'installed' || event.kind === 'install_stopped'

/** The newest install result for this machine. The ring is newest first. */
export function newestInstall(events: Event[], machine: string): Event | undefined {
  return events.find((event) => isInstall(event) && event.machine === machine)
}

/** What this page pressed: the newest result it had already seen, so the next
 *  one is the answer, and the browser's own instant for the lost-result check.
 *  The answer is found by comparing event times with each other, so the two
 *  clocks need not agree; the age the card prints does mix them, as every age
 *  in the dashboard does. */
export type Watch = { since: number; pressed: number }

/** The result that answers this page's press, or null while it runs. */
export function answer(events: Event[], machine: string, watch: Watch): Event | null {
  const newest = newestInstall(events, machine)
  return newest && newest.at > watch.since ? newest : null
}

/** A command the person runs because sudo there wants a password
 *  (`Because::SudoAsks`, the one step install.rs prefixes with `sudo`). */
export const needsSudo = (command: string) => command.startsWith('sudo ')

/** The daemon waits 15 minutes (`INSTALL_BUDGET`) and then says so, so a page
 *  that has heard nothing a minute later has lost the result — a daemon
 *  restart empties the ring (ADR-0025). */
export const LOST_MS = 16 * 60_000

/** "tmux", "tmux and claude", "tmux, git and claude". */
export function listed(names: string[]): string {
  if (names.length < 2) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}
