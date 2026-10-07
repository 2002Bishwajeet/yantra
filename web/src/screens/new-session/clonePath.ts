import { useQuery } from '@tanstack/react-query'
import type { Listing } from '@/api'
import { dirsQuery } from '@/api/queries'
import { trimSlash } from '@/lib/path'
import { type Prefs, readPrefs, usePrefs, writePrefs } from '@/shell/prefs'

/** The directory in `listing` called `name`, in any letter case: `GitHub`
 *  and `github` are the folder a person already keeps repositories in. */
export function findFolder(listing: Listing | undefined, name: string): string | null {
  const wanted = name.toLowerCase()
  const hit = listing?.entries.find((one) => one.kind === 'dir' && one.access && one.name.toLowerCase() === wanted)
  return hit?.path ?? null
}

/** The first provider folder that exists, `~/<name>` before
 *  `~/Documents/<name>`; where none exists, `~/<name>`, which a clone makes. */
export function defaultCloneFolder(
  home: string,
  inHome: Listing | undefined,
  inDocuments: Listing | undefined,
  name = 'Github',
): string {
  return findFolder(inHome, name) ?? findFolder(inDocuments, name) ?? `${home}/${name}`
}

// Per machine, in General's bag: a clone folder is a path on one machine.
function held(prefs: Prefs, machine: string): string | null {
  const folders = prefs.general.cloneFolders
  const path = folders && typeof folders === 'object' ? (folders as Record<string, unknown>)[machine] : null
  return typeof path === 'string' ? path : null
}

export function rememberCloneFolder(machine: string, path: string) {
  const { general } = readPrefs()
  const folders = (general.cloneFolders ?? {}) as Record<string, unknown>
  writePrefs({ general: { ...general, cloneFolders: { ...folders, [machine]: path } } })
}

/** The machine's clone folder: the one remembered in this browser, else the
 *  existing provider folder. `folder` is null while the listings that decide
 *  it are still coming. */
export function useCloneFolder(machine: string) {
  const prefs = usePrefs()
  const home = useQuery({ ...dirsQuery(machine, null), enabled: true })
  const root = home.data ? trimSlash(home.data.path) : null
  const documents = findFolder(home.data, 'Documents')
  // A disabled query still reads the cache, and `null` is `$HOME`'s key; '' is nobody's.
  const docs = useQuery({ ...dirsQuery(machine, documents ?? ''), enabled: documents !== null })
  const saved = held(prefs, machine)
  const decided = home.data !== undefined && (documents === null || !docs.isPending)
  const folder = saved ?? (decided && root !== null ? defaultCloneFolder(root, home.data, docs.data) : null)
  return { root, folder, home }
}
