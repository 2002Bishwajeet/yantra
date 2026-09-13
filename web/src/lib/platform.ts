import type { Machine } from '@/api'

/** Tailscale's `os` for the two systems a session runs on: tmux and `/bin/sh`
 *  are there (walk-through §3.6). */
export const runsSessions = (machine: Pick<Machine, 'os'>) => machine.os === 'linux' || machine.os === 'macOS'

/** What a node that runs no session is, in the dashboard's words (owner, 2026-09-12). */
export function apart(machine: Pick<Machine, 'os'>): string {
  if (machine.os === 'windows') return 'Windows · coming soon as a machine for sessions · opens the dashboard meanwhile'
  if (machine.os === 'iOS' || machine.os === 'android') return 'opens the dashboard · runs no session'
  return `${machine.os || 'an unnamed system'} · runs no session`
}

/** The four flows of Add a device (walk-through §3.2). */
export const PLATFORMS = ['linux', 'macOS', 'phone', 'windows'] as const
export type Platform = (typeof PLATFORMS)[number]

export const platformName: Record<Platform, string> = {
  linux: 'Linux',
  macOS: 'macOS',
  phone: 'Phone or tablet',
  windows: 'Windows',
}

export const asPlatform = (given: unknown): Platform | undefined => PLATFORMS.find((one) => one === given)

/** Which flow a tailnet node belongs to, from the `os` Tailscale reports. */
export function platformOf(machine: Pick<Machine, 'os'>): Platform | null {
  if (machine.os === 'iOS' || machine.os === 'android') return 'phone'
  return PLATFORMS.find((one) => one === machine.os) ?? null
}

/** The owner's guess (walk-through Q3.1), from this browser. An iPad asks for
 *  the desktop site and says Macintosh, so touch is what tells it apart. */
export function guessPlatform(browser: { userAgent: string; maxTouchPoints?: number }): Platform {
  const agent = browser.userAgent
  if (/iPhone|iPad|iPod|Android/i.test(agent)) return 'phone'
  if (/Macintosh|Mac OS X/i.test(agent)) return (browser.maxTouchPoints ?? 0) > 1 ? 'phone' : 'macOS'
  if (/Windows/i.test(agent)) return 'windows'
  return 'linux'
}
