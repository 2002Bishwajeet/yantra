import type { About } from '@/api'
import { fetchJson, fields } from '@/api/client'
import { asApiError, type ApiError } from '@/api/errors'

/** Y-652: what the page-load step did. Only `moved` leaves the page; every
 *  other answer keeps it on `:7717`, where Talk says why the mic is off. */
export type Secure =
  | { kind: 'secure' }
  | { kind: 'moved'; to: string; carried: number }
  | { kind: 'no-origin' }
  | { kind: 'about-failed'; error: ApiError }
  | { kind: 'unreachable' }

type Store = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>

export type Page = {
  isSecureContext: boolean
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'replace'>
  localStorage: Store
}

// Each origin has its own localStorage, so the move takes this page's keys
// along in the fragment, which the browser never sends to the daemon.
const CARRY = '#yantra-carry='
const PREFIX = 'yantra.'

type Carry = { hash: string; kept: Record<string, string> }

/** Every key this dashboard keeps: drafts, modes, prefs and the editor. */
function kept(storage: Store): Record<string, string> {
  const found: Record<string, string> = {}
  try {
    for (let at = 0; at < storage.length; at++) {
      const key = storage.key(at)
      const value = key?.startsWith(PREFIX) ? storage.getItem(key) : null
      if (key && value !== null) found[key] = value
    }
  } catch {
    // A store the browser refuses holds nothing to carry.
  }
  return found
}

/** Sends a plain-HTTP page to the daemon's HTTPS origin, where the browser
 *  allows the microphone (ADR-0031 §4). It moves only after that origin
 *  answers, because the daemon cannot see whether `tailscale serve` runs. */
export async function toSecure(page: Page = window, timeoutMs = 3000): Promise<Secure> {
  if (page.isSecureContext) return { kind: 'secure' }
  let about: About
  try {
    about = await fetchJson<About>('/api/about', {}, fields('https'))
  } catch (error) {
    return { kind: 'about-failed', error: asApiError(error) }
  }
  const { https } = about
  if (!https) return { kind: 'no-origin' }
  try {
    // Opaque, so it says only that the origin answered, which is all it needs.
    await fetch(`${https}/healthz`, { mode: 'no-cors', signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return { kind: 'unreachable' }
  }
  const { pathname, search, hash } = page.location
  const carry: Carry = { hash, kept: kept(page.localStorage) }
  const to = `${https}${pathname}${search}${CARRY}${encodeURIComponent(JSON.stringify(carry))}`
  // Moved, not copied: a later visit to :7717 must not bring back a draft sent since.
  try {
    for (const key of Object.keys(carry.kept)) page.localStorage.removeItem(key)
  } catch {
    // The keys stay here as well, which loses nothing.
  }
  page.location.replace(to)
  return { kind: 'moved', to, carried: Object.keys(carry.kept).length }
}

export type Arrived = { kind: 'none' } | { kind: 'arrived'; kept: number } | { kind: 'unreadable' }

export type Landing = {
  location: Pick<Location, 'pathname' | 'search' | 'hash'>
  history: Pick<History, 'replaceState'>
  localStorage: Store
}

function isCarry(value: unknown): value is Carry {
  if (typeof value !== 'object' || value === null) return false
  const { hash, kept } = value as Partial<Carry>
  return (
    typeof hash === 'string' &&
    typeof kept === 'object' &&
    kept !== null &&
    Object.values(kept).every((one) => typeof one === 'string')
  )
}

function parse(payload: string): Carry | null {
  try {
    const body: unknown = JSON.parse(decodeURIComponent(payload))
    return isCarry(body) ? body : null
  } catch {
    return null
  }
}

/** The other half of `toSecure`, run before the first render so every screen
 *  reads the carried keys. A key this origin already holds keeps its own value,
 *  so a link cannot overwrite what was typed here. */
export function arrive(page: Landing = window): Arrived {
  const { pathname, search, hash } = page.location
  if (!hash.startsWith(CARRY)) return { kind: 'none' }
  const carry = parse(hash.slice(CARRY.length))
  page.history.replaceState(null, '', `${pathname}${search}${carry?.hash ?? ''}`)
  if (!carry) return { kind: 'unreadable' }
  let written = 0
  try {
    for (const [key, value] of Object.entries(carry.kept)) {
      if (!key.startsWith(PREFIX) || page.localStorage.getItem(key) !== null) continue
      page.localStorage.setItem(key, value)
      written++
    }
  } catch {
    // A store that refuses writes: this page starts with what it has.
  }
  return { kind: 'arrived', kept: written }
}

/** Renders only after the move is decided, so nothing typed on :7717 is left
 *  behind in the 300 ms before a draft is written. */
export async function boot(
  render: () => void,
  move: () => Promise<Secure> = toSecure,
  land: () => Arrived = arrive,
): Promise<Secure> {
  land()
  let secure: Secure | null = null
  try {
    secure = await move()
  } finally {
    // A step that threw still leaves a page to work on.
    if (secure?.kind !== 'moved') render()
  }
  return secure
}
