import type { Entry } from '@/api'
import { trimSlash } from '@/lib/path'
import { type Prefs, readPrefs, writePrefs } from '@/shell/prefs'

const RECENT_MAX = 5

// Folders you can enter come first, repositories before plain folders; files
// and folders the account cannot read sit below them.
const rank = (entry: Entry): number =>
  !entry.access ? 3 : entry.kind === 'file' ? 2 : entry.repo ? 0 : 1

/** The entries the picker draws: dotfiles only when `hidden`, names that
 *  contain `filter` in any letter case, and the git-first order the daemon
 *  does not give (it sorts directories before files and stops). */
export function arrange(entries: Entry[], opts: { hidden: boolean; filter: string }): Entry[] {
  const wanted = opts.filter.trim().toLowerCase()
  return entries
    .filter((entry) => (opts.hidden || !entry.name.startsWith('.')) && entry.name.toLowerCase().includes(wanted))
    .sort((a, b) => rank(a) - rank(b) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1))
}

// Per machine, in General's bag, and read defensively: the bag is shared and
// another version of the page may have written another shape.
function bag(prefs: Prefs, key: 'lastFolders' | 'recentFolders', machine: string): unknown {
  const all = prefs.general[key]
  return all && typeof all === 'object' ? (all as Record<string, unknown>)[machine] : undefined
}

export function lastFolder(prefs: Prefs, machine: string): string | null {
  const path = bag(prefs, 'lastFolders', machine)
  return typeof path === 'string' && path.startsWith('/') ? path : null
}

export function recentFolders(prefs: Prefs, machine: string): string[] {
  const paths = bag(prefs, 'recentFolders', machine)
  if (!Array.isArray(paths)) return []
  return paths.filter((one): one is string => typeof one === 'string' && one.startsWith('/')).slice(0, RECENT_MAX)
}

/** Called once a workspace is created, never on a walk: browsing past a
 *  folder says nothing about the folder you meant. */
export function rememberFolder(machine: string, path: string) {
  const prefs = readPrefs()
  const folder = trimSlash(path)
  const object = (key: string): Record<string, unknown> => {
    const held = prefs.general[key]
    return held && typeof held === 'object' && !Array.isArray(held) ? (held as Record<string, unknown>) : {}
  }
  const recent = [folder, ...recentFolders(prefs, machine).filter((one) => one !== folder)].slice(0, RECENT_MAX)
  writePrefs({
    general: {
      ...prefs.general,
      lastFolders: { ...object('lastFolders'), [machine]: folder },
      recentFolders: { ...object('recentFolders'), [machine]: recent },
    },
  })
}
