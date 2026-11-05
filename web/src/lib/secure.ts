import type { About } from '@/api'
import { fetchJson, fields } from '@/api/client'
import { asApiError, type ApiError } from '@/api/errors'

/** Y-652: what the page-load step did. Only `moved` leaves the page; every
 *  other answer keeps it on `:7717`, where Talk says why the mic is off. */
export type Secure =
  | { kind: 'secure' }
  | { kind: 'moved'; to: string }
  | { kind: 'no-origin' }
  | { kind: 'about-failed'; error: ApiError }
  | { kind: 'unreachable' }

export type Page = {
  isSecureContext: boolean
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'replace'>
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
  const to = `${https}${pathname}${search}${hash}`
  page.location.replace(to)
  return { kind: 'moved', to }
}
