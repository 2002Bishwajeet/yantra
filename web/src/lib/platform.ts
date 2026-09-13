import type { Machine } from '@/api'

/** Why a node another owner holds is not yours to use (owner, 2026-09-13,
 *  Y-404); `null` is a node your account owns. */
export function notYours(machine: Pick<Machine, 'ownership'>): string | null {
  if (machine.ownership === 'shared') return 'shared from another account · not supported yet'
  if (machine.ownership === 'tagged') return 'tagged, so the tailnet owns it and not your account · not supported yet'
  return null
}

/** Tailscale's `os` for the two systems a session runs on: tmux and `/bin/sh`
 *  are there (walk-through §3.6). A node you do not own never counts (Y-404). */
export const runsSessions = (machine: Pick<Machine, 'os' | 'ownership'>) =>
  machine.ownership === 'yours' && (machine.os === 'linux' || machine.os === 'macOS')

/** What a node that runs no session is, in the dashboard's words (owner, 2026-09-12). */
export function apart(machine: Pick<Machine, 'os' | 'ownership'>): string {
  const reason = notYours(machine)
  if (reason) return reason
  if (machine.os === 'windows') return 'Windows · coming soon as a machine for sessions · opens the dashboard meanwhile'
  if (machine.os === 'iOS' || machine.os === 'android') return 'opens the dashboard · runs no session'
  return `${machine.os || 'an unnamed system'} · runs no session`
}

/** The four flows of Add a device, spelled as its address spells them
 *  (D7 §4.2, `?platform=`). */
export const PLATFORMS = ['linux', 'macos', 'mobile', 'windows'] as const
export type Platform = (typeof PLATFORMS)[number]

export const platformName: Record<Platform, string> = {
  linux: 'Linux',
  macos: 'macOS',
  mobile: 'Phone or tablet',
  windows: 'Windows',
}

export const asPlatform = (given: unknown): Platform | undefined => PLATFORMS.find((one) => one === given)

/** Which flow a tailnet node belongs to, from the `os` Tailscale reports. */
export function platformOf(machine: Pick<Machine, 'os'>): Platform | null {
  if (machine.os === 'linux') return 'linux'
  if (machine.os === 'macOS') return 'macos'
  if (machine.os === 'iOS' || machine.os === 'android') return 'mobile'
  if (machine.os === 'windows') return 'windows'
  return null
}

/** The owner's guess (walk-through Q3.1), from this browser. An iPad asks for
 *  the desktop site and says Macintosh, so touch is what tells it apart. */
export function guessPlatform(browser: { userAgent: string; maxTouchPoints?: number }): Platform {
  const agent = browser.userAgent
  if (/iPhone|iPad|iPod|Android/i.test(agent)) return 'mobile'
  if (/Macintosh|Mac OS X/i.test(agent)) return (browser.maxTouchPoints ?? 0) > 1 ? 'mobile' : 'macos'
  if (/Windows/i.test(agent)) return 'windows'
  return 'linux'
}
