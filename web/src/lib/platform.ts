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
