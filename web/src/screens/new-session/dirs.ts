import { useMachines } from '@/api/hooks'
import { fullDisk } from '@/lib/checks'

/** `/ home ~ Github yantra`: every segment is a way back up, to `/` itself
 *  (Y-414). The segment that is `$HOME` reads `~`. */
export function crumbs(here: string, home: string | null): { label: string; path: string }[] {
  const out = [{ label: '/', path: '/' }]
  let path = ''
  for (const segment of here.split('/').filter(Boolean)) {
    path = `${path}/${segment}`
    out.push({ label: path === home ? '~' : segment, path })
  }
  return out
}

/** `name` under `dir`, with one slash at the root rather than two. */
export const under = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`)

/** macOS refuses an ssh login ~/Documents, ~/Desktop and ~/Downloads until
 *  Remote Login allows full disk access (Y-458). Elsewhere it is the
 *  folder's own permissions, and `os` unread says no more than that (Y-591). */
export const noAccess = (machine: string, os: string | undefined) =>
  os === 'macOS'
    ? `macOS blocks remote access to this folder. ${fullDisk(machine)}`
    : `${machine} does not let this account read this folder.`

export function useNoAccess(machine: string): string {
  const machines = useMachines()
  const os = machines.looked === 'ok' ? machines.data.find((one) => one.name === machine)?.os : undefined
  return noAccess(machine, os)
}
