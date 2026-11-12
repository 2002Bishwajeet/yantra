/** Why an admin account name is refused, by the daemon's own rule
 *  (`identity::usable_user`, I-63): it reaches ssh as `<name>@<machine>`. */
export type AdminProblem = 'empty' | 'long' | 'lead' | 'char'

export function adminProblem(name: string): AdminProblem | null {
  if (name === '') return 'empty'
  if (name.length > 32) return 'long'
  if (name.startsWith('-') || name.startsWith('.')) return 'lead'
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'char'
  return null
}

export const problemWords: Record<AdminProblem, string> = {
  empty: 'Name the admin account first',
  long: 'An account name is at most 32 characters',
  lead: 'An account name cannot start with - or .',
  char: 'Use letters, digits, ., _ and - only',
}

// A per-viewer convenience (ADR-0046 §2.1): the daemon keeps nothing, and a
// browser that refuses storage asks again next time.
const key = (machine: string) => `yantra.owner.${machine}`

export function rememberedAdmin(machine: string): string {
  try {
    return localStorage.getItem(key(machine)) ?? ''
  } catch {
    return ''
  }
}

export function rememberAdmin(machine: string, name: string) {
  try {
    if (name === '') localStorage.removeItem(key(machine))
    else localStorage.setItem(key(machine), name)
  } catch {
    // Kept for this visit only.
  }
}

/** What the owner sheet has open: the command to type in, and the admin
 *  account once it is named. */
export type OwnerRun = { command: string; admin: string | null }

/** The kept account is read at the press: an edit to it while the sheet is
 *  open must not reopen the socket as someone else. */
export function ownerRun(machine: string, command: string): OwnerRun {
  const kept = rememberedAdmin(machine)
  return { command, admin: adminProblem(kept) ? null : kept }
}
