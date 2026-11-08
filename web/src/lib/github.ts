import type { Check, Connection } from '@/api'
import type { Reading } from '@/api/client'

/** What the daemon holds (`/api/github`) read with what GitHub said about it
 *  (`/api/readiness/github`). A grant GitHub refused is still `connected`. */
export type Grant =
  | { kind: 'asking' }
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'accepted'; login: string | null }
  | { kind: 'refused'; login: string | null }
  | { kind: 'unasked'; login: string | null }

export function grant(connection: Connection | undefined, readiness: Reading<Check>): Grant {
  if (connection === undefined) return { kind: 'asking' }
  if (!connection.connected) return { kind: connection.pending ? 'pending' : 'none' }
  const { login } = connection
  // Anything but a check that was made is a grant nobody asked GitHub about.
  if (readiness.looked !== 'ok') return { kind: 'unasked', login }
  if (readiness.data.state === 'present') return { kind: 'accepted', login }
  return { kind: readiness.data.state === 'absent' ? 'refused' : 'unasked', login }
}

export const REFUSED = 'GitHub refused the grant'

/** "Signed in as X", or "Signed in" while the login is unread. */
export const signedIn = (login: string | null) => (login ? `Signed in as ${login}` : 'Signed in')

/** The Providers row's supporting text for a held grant. */
export function held(g: Extract<Grant, { kind: 'accepted' | 'unasked' | 'refused' }>, phone: boolean): string {
  if (g.kind === 'refused') return REFUSED
  if (g.login) return phone ? `Connected as ${g.login}` : `signed in as ${g.login} · repositories, reviews, issues`
  return g.kind === 'unasked' ? 'Signed in · GitHub not asked yet' : 'Signed in · repositories, reviews, issues'
}
