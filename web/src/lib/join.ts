import type { About } from '@/api'

/** Where `GET /join` answers. On HTTPS the page came through `tailscale serve`,
 *  which forwards `/join` too; on HTTP it is the daemon's own bound address. */
export function joinUrl(page: { protocol: string; origin: string }, about: About | undefined): string | null {
  if (page.protocol === 'https:') return `${page.origin}/join`
  const bound = about?.listening_on[0]
  return bound ? `http://${bound}/join` : null
}

export const joinCommand = (url: string) => `curl -fsSL ${url} | sh`
