import type { Machine, Readiness, Repo, Workspace } from '@/api'
import { USABLE_NAME } from '@/lib/name'
import { trimSlash } from '@/lib/path'
import type { Step } from '@/router'

/** D4 §5's three answers: only a proven absence blocks. */
export type Checked = 'yes' | 'no' | 'unknown'

/** Where the code comes from, once decided. A repository is read against
 *  its default clone path on the machine; a directory is where you walked. */
export type Source =
  | { kind: 'github'; repo: Repo; path: string; here: Checked; because?: string }
  | { kind: 'local'; path: string; origin: string | null; checked: Checked; because?: string }

export type Provider = 'github' | 'local'

export type Values = {
  name: string
  /** Typed by hand, so the name stops following the source (D4 §4.3). */
  named: boolean
  machine: string
  provider: Provider
  source: Source | null
  opens: 'claude' | 'command'
  command: string
}

/** One label per panel. */
export const STEPS = ['Name', 'Source', 'Start'] as const

export const nameError = (name: string): string | undefined =>
  name === ''
    ? 'A session needs a name.'
    : USABLE_NAME.test(name)
      ? undefined
      : 'The daemon takes letters, digits, - and _ and nothing else, so it would refuse this one.'

/** The machine a preset may select: only one that is yours and reachable now,
 *  since a disabled chip must never be pressed. */
export const pickMachine = (given: string, machines: Machine[]): string =>
  machines.some((one) => one.name === given && one.ownership === 'yours' && one.online && !one.expired)
    ? given
    : ''

/** The hub is the daemon's own host, and sessions run there only as an account
 *  that joined. Same rule as Setup: online, and ssh got in (Y-627). */
export const hubJoined = (machine: Machine, report: Readiness | null): boolean =>
  machine.online && !!report?.checks.some((one) => one.check === 'reachable' && one.state === 'present')

/** The machines a chip may be drawn for: a hub no account has joined is left out. */
export const offered = (machines: Machine[], reports: (Readiness | null)[]): Machine[] =>
  machines.filter((one, index) => !one.hub || hubJoined(one, reports[index] ?? null))

/** Whether a step is complete enough to leave. */
export function complete(step: Step, values: Values): boolean {
  switch (step) {
    case 1:
      return nameError(values.name) === undefined && values.machine !== ''
    case 2: {
      const { source } = values
      if (!source) return false
      // A repository that is not on the machine is the clone, so only a
      // directory proven absent blocks (D4 §5).
      return source.kind === 'github' || source.checked !== 'no'
    }
    case 3:
      return values.opens === 'claude' || (values.opens === 'command' && values.command.trim() !== '')
    case 4:
      return false
  }
}

/** The furthest step the values allow, so `?step=4` on an empty form draws
 *  step 1 rather than a create with nothing in it. */
export function reachable(values: Values): Step {
  if (!complete(1, values)) return 1
  if (!complete(2, values)) return 2
  if (!complete(3, values)) return 3
  return 4
}

/** `owner/name` → `name`; the directory a clone lands in. */
export const repoName = (repo: Repo): string => repo.full_name.split('/').pop() ?? repo.full_name

/** Where a repository is cloned when it is not on the machine: under the
 *  machine's clone folder (clonePath.ts). */
export const cloneInto = (folder: string, repo: Repo): string => `${folder}/${repoName(repo)}`

/** `/home/you/Github/x` drawn as `~/Github/x`, as the boards write paths. */
export function tilde(path: string, home: string | null): string {
  if (home === null) return path
  const base = trimSlash(home)
  if (path === base) return '~'
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path
}

export const NO_HOME = 'This machine has not said where home is yet. Type the full path.'

/** What `tilde` draws, read back: `~` and `~/x` become paths under `home`. `null` when `~` needs a home not yet known. */
export function expand(path: string, home: string | null): string | null {
  if (path !== '~' && !path.startsWith('~/')) return path
  if (home === null) return null
  return `${trimSlash(home).replace(/\/$/, '')}${path.slice(1)}`
}

/** `origin` as the boards write it: `owner/name`, without host or `.git`. */
export function slug(origin: string): string {
  const tail = origin.replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = tail.split(/[/:]/)
  return parts.slice(-2).join('/')
}

/** What the starting screen runs, in the daemon's own terms. `startup` is
 *  omitted for Claude: the workspace runs nothing of its own and `up` passes
 *  the agent (NewWorkspace.tsx, ADR-0015). */
export type Plan = {
  name: string
  machine: string
  path: string
  startup?: string
  /** A repository not on the machine; `null` is a path that is there, or one
   *  the machine could not be asked about and `up` will try. */
  clone: { url: string; full_name: string } | null
  /** Only the Local picker remembers its folder; a clone destination is not one. */
  local?: true
}

export function plan(values: Values): Plan | null {
  const { source } = values
  if (!source || reachable(values) !== 4) return null
  const command = values.command.trim()
  return {
    name: values.name,
    machine: values.machine,
    path: source.path,
    ...(values.opens === 'command' ? { startup: command } : {}),
    ...(source.kind === 'local' ? { local: true as const } : {}),
    clone:
      source.kind === 'github' && source.here === 'no'
        ? { url: source.repo.clone_url, full_name: source.repo.full_name }
        : null,
  }
}

/** The one line step 3 adds to what the header already says; `null` when the folder is already there. */
export function next(values: Values): string | null {
  const { source } = values
  if (source?.kind === 'github' && source.here === 'no') return `Clones ${source.repo.full_name} first.`
  const unchecked = source?.kind === 'github' ? source.here === 'unknown' : source?.checked === 'unknown'
  return unchecked ? 'Yantra checks the folder first.' : null
}

/** The line under step 2 that says why Continue is off, or what it will do. */
export function sourceHint(values: Values, home: string | null, listed = true): string | null {
  const { source } = values
  if (!source) {
    if (values.provider === 'local') return 'Choose a folder that exists to continue.'
    // No rows on screen: the panel already names the blocker, and "choose" would point at nothing.
    return listed ? 'Choose a repository to continue.' : null
  }
  if (source.kind === 'local') return source.checked === 'no' ? 'Choose a folder that exists to continue.' : null
  const path = tilde(source.path, home)
  if (source.here === 'no') return `Will clone into ${path}`
  if (source.here === 'yes') return `On ${values.machine} at ${path}`
  return `Not checked. Will try ${path}`
}

/** The workspace that already works in the chosen folder on the chosen machine. */
export function knownWorkspace(values: Values, workspaces: Workspace[]): Workspace | null {
  if (!values.source) return null
  const path = trimSlash(values.source.path)
  return workspaces.find((one) => one.machine === values.machine && trimSlash(one.repo) === path) ?? null
}
