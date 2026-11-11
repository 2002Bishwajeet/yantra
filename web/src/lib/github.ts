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

/** Where GitHub lets the account grant Yantra's OAuth app each organisation.
 *  Without a client id, the list of every authorised app. */
export const grantPage = (clientId: string | null) =>
  clientId
    ? `https://github.com/settings/connections/applications/${encodeURIComponent(clientId)}`
    : 'https://github.com/settings/applications'

/** Never claims a full list: GitHub cannot name a private membership in an organisation that restricts the app. */
export const hiddenNote = (orgs: string[]) =>
  orgs.length === 0
    ? 'A private membership is not listed.'
    : `A private membership is not listed. No repository from ${orgs.join(', ')}.`

export const REFUSED = 'GitHub refused the grant'

/** Why a sign-in ended with no grant: the OAuth App opted in to token expiry. */
export const EXPIRING =
  'GitHub issued a token that expires after 8 hours, and Yantra needs one that does not. In your OAuth App’s settings on github.com, under Optional features, opt out of user-to-server token expiration, then sign in again.'
export const APP_SETTINGS = 'https://github.com/settings/developers'

/** "Signed in as X", or "Signed in" while the login is unread. */
export const signedIn = (login: string | null) => (login ? `Signed in as ${login}` : 'Signed in')

/** The Providers row's supporting text for a held grant. */
export function held(g: Extract<Grant, { kind: 'accepted' | 'unasked' | 'refused' }>, phone: boolean): string {
  if (g.kind === 'refused') return REFUSED
  if (g.login) return phone ? `Connected as ${g.login}` : `signed in as ${g.login} · repositories, reviews, issues`
  return g.kind === 'unasked' ? 'Signed in · GitHub not asked yet' : 'Signed in · repositories, reviews, issues'
}
