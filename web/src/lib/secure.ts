import type { About, Carried } from '@/api'
import { fetchJson, fields, json, type Shape } from '@/api/client'
import { asApiError, type ApiError } from '@/api/errors'

/** Y-652: what the page-load step did. Only `moved` leaves the page; every
 *  other answer keeps it on `:7717`, where Talk says why the mic is off. */
export type Secure =
  | { kind: 'secure' }
  | { kind: 'moved'; to: string; carried: number }
  | { kind: 'no-origin' }
  | { kind: 'about-failed'; error: ApiError }
  | { kind: 'unreachable' }
  | { kind: 'carry-failed'; error: ApiError }

type Store = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>

export type Page = {
  isSecureContext: boolean
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'replace'>
  localStorage: Store
}

// The keys go through the daemon's memory (carry.rs), so the address and the
// browser's history hold only a one-time id. A link must not choose a
// permission mode, so `yantra.chat.mode.*` stays on :7717.
const CARRY = '#yantra-carry='
const CARRIED = /^yantra\.(prefs|editor|chat\.interaction\..+|chat\.draft\..+)$/
const ID = /^[0-9a-f]{32}$/

/** The keys this page can carry: prefs, the editor, plan mode and drafts. */
function kept(storage: Store): Record<string, string> {
  const found: Record<string, string> = {}
  try {
    for (let at = 0; at < storage.length; at++) {
      const key = storage.key(at)
      const value = key && CARRIED.test(key) ? storage.getItem(key) : null
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
  const keys = kept(page.localStorage)
  const carried = Object.keys(keys).length
  let to = `${https}${pathname}${search}${hash}`
  if (carried > 0) {
    try {
      const { id } = await fetchJson<Carried>('/api/carry', { method: 'POST', ...json(keys) }, fields('id'))
      to = `${https}${pathname}${search}${CARRY}${id}&${encodeURIComponent(hash)}`
    } catch (error) {
      return { kind: 'carry-failed', error: asApiError(error) }
    }
    // Moved, not copied: a copy here would come back over a newer value on a later visit.
    try {
      for (const key of Object.keys(keys)) page.localStorage.removeItem(key)
    } catch {
      // The keys stay here as well, which loses nothing.
    }
  }
  page.location.replace(to)
  return { kind: 'moved', to, carried }
}

/** `lost` is a slot the daemon no longer holds: taken, expired, or a restart. */
export type Arrived =
  | { kind: 'none' }
  | { kind: 'arrived'; kept: number }
  | { kind: 'lost' }
  | { kind: 'failed'; error: ApiError }

export type Landing = {
  location: Pick<Location, 'pathname' | 'search' | 'hash'>
  history: Pick<History, 'replaceState'>
  localStorage: Store
}

const anObject: Shape = (body) =>
  typeof body === 'object' && body !== null && !Array.isArray(body) ? null : 'body'

function restored(encoded: string): string {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return ''
  }
}

/** The other half of `toSecure`, run before the first render so every screen
 *  reads the carried keys. A carried key replaces the one held here: the owner
 *  comes from the page that set it last. */
export async function arrive(page: Landing = window): Promise<Arrived> {
  const { pathname, search, hash } = page.location
  if (!hash.startsWith(CARRY)) return { kind: 'none' }
  const rest = hash.slice(CARRY.length)
  const split = rest.indexOf('&')
  const id = split < 0 ? rest : rest.slice(0, split)
  // Out of the address first, so a reload or a shared link never asks again.
  page.history.replaceState(null, '', `${pathname}${search}${split < 0 ? '' : restored(rest.slice(split + 1))}`)
  if (!ID.test(id)) return { kind: 'lost' }
  let keys: Record<string, unknown>
  try {
    keys = await fetchJson<Record<string, unknown>>(`/api/carry/${id}`, { method: 'POST' }, anObject)
  } catch (error) {
    const failure = asApiError(error)
    return failure.kind === 'missing' ? { kind: 'lost' } : { kind: 'failed', error: failure }
  }
  let written = 0
  try {
    for (const [key, value] of Object.entries(keys)) {
      if (!CARRIED.test(key) || typeof value !== 'string') continue
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
  land: () => Promise<Arrived> = arrive,
): Promise<Secure> {
  let secure: Secure | null = null
  try {
    await land()
    secure = await move()
  } finally {
    // A step that threw still leaves a page to work on.
    if (secure?.kind !== 'moved') render()
  }
  return secure
}
