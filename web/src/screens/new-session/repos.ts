import type { Listing, Repo } from '@/api'
import { type Checked, cloneInto, slug } from './form'

/** How many rows are drawn: typing narrows, and a list of everything a person
 *  owns is a scroll rather than an answer (D4 §2). */
export const SHOWN = 8

/** The search box filters the swept list in the browser (plan §5.4). */
export function filterRepos(repos: Repo[], query: string): Repo[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return repos
  return repos.filter((one) => one.full_name.toLowerCase().includes(needle))
}

/** Where one repository sits on the machine: the path, and whether it is
 *  there. `unknown` is a machine that could not be asked. */
export type Placement = { path: string; here: Checked; because?: string }

/** `owner/name` → the directory that holds it, from one listing of the clone
 *  home. One ssh round trip answers every row, where a probe each would be
 *  eight. */
export function byOrigin(listing: Listing | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of listing?.entries ?? []) {
    if (entry.origin) out.set(slug(entry.origin).toLowerCase(), entry.path)
  }
  return out
}

export function place(
  repo: Repo,
  home: string,
  held: Map<string, string>,
  because?: string,
): Placement {
  const at = held.get(repo.full_name.toLowerCase())
  if (at !== undefined) return { path: at, here: 'yes' }
  const path = cloneInto(home, repo)
  return because === undefined ? { path, here: 'no' } : { path, here: 'unknown', because }
}
