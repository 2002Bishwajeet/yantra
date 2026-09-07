import type { Repo } from '@/api'
import { USABLE_NAME } from '@/lib/name'
import type { Step } from '@/router'

/** D4 §5's three answers: only a proven absence blocks. */
export type Checked = 'yes' | 'no' | 'unknown'

/** Where the code comes from, once decided. A repository is read against
 *  its default clone path on the machine; a directory is where you walked. */
export type Source =
  | { kind: 'github'; repo: Repo; path: string; here: Checked; because?: string }
  | { kind: 'local'; path: string; origin: string | null; checked: Checked; because?: string }

export type Provider = 'github' | 'gitlab' | 'local'

export type Values = {
  name: string
  /** Typed by hand, so the name stops following the source (D4 §4.3). */
  named: boolean
  machine: string
  provider: Provider
  source: Source | null
  opens: 'claude' | 'command' | 'later'
  command: string
}

export const STEPS = ['Name', 'Source', 'Start', 'Create'] as const

export const nameError = (name: string): string | undefined =>
  name === ''
    ? 'A session needs a name.'
    : USABLE_NAME.test(name)
      ? undefined
      : 'The daemon takes letters, digits, - and _ and nothing else, so it would refuse this one.'

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
 *  provider's own directory (canvas note `y332-new-session`). */
export const cloneHome = (home: string): string => `${home}/Github`
export const cloneInto = (home: string, repo: Repo): string =>
  `${cloneHome(home)}/${repoName(repo)}`

/** `/home/you/Github/x` drawn as `~/Github/x`, as the boards write paths. */
export function tilde(path: string, home: string | null): string {
  if (home === null) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
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
    clone:
      source.kind === 'github' && source.here === 'no'
        ? { url: source.repo.clone_url, full_name: source.repo.full_name }
        : null,
  }
}

/** The "What will happen" list, derived from the choices (NewSessionStart). */
export function happenings(values: Values, home: string | null): string[] {
  const { source } = values
  const where = source ? tilde(source.path, home) : '…'
  const out = [`write ~/.config/yantra/workspaces/${values.name}.toml`]
  if (source?.kind === 'github' && source.here === 'no') {
    out.push(`clone ${source.repo.full_name} into ${where} on ${values.machine}`)
    out.push(`open a tmux session on ${values.machine} in ${where}`)
  } else {
    const state =
      source?.kind === 'github'
        ? source.here === 'yes'
          ? ', which is already there'
          : ', which will be tried then'
        : source?.checked === 'unknown'
          ? ', which will be tried then'
          : ', which is already there'
    out.push(`open a tmux session on ${values.machine} in ${where}${state}`)
  }
  out.push(
    values.opens === 'command'
      ? `run ${values.command.trim() || '…'} in it and attach this browser to the pane`
      : 'start Claude in it and attach this browser to the pane',
  )
  return out
}
