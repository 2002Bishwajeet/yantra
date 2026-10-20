import type { Placed, Placement, Unplaced, Workspace } from '@/api'

export type Choice = {
  workspace: Workspace
  /** Why this machine ranks where it does, or why it cannot be ranked. */
  reason: string | null
  /** The machine has no fresh beat: it stays listed, last. */
  asleep: boolean
}

export type Picks = {
  choices: Choice[]
  /** False when the ranking is missing, so the list is in name order. */
  ranked: boolean
}

const WHY: Record<Unplaced['why'], string> = {
  never_heard: 'no heartbeat yet',
  not_reporting: 'not reporting',
  asleep_or_off: 'asleep or off',
}

const tail = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? ''

/** Same rule as placement.rs `ran_here`: the last path segment names the repo. */
export function pickWorkspaces(workspaces: Workspace[], issueRepo: string, placement: Placement | null): Picks {
  const wanted = issueRepo.split('/').pop()?.toLowerCase() ?? ''
  const matches = workspaces.filter((one) => tail(one.repo).toLowerCase() === wanted)
  const ranking = new Map<string, Placed>((placement?.ranked ?? []).map((one) => [one.machine, one]))
  const rejected = new Map<string, Unplaced>((placement?.rejected ?? []).map((one) => [one.machine, one]))

  const choices = matches.map((workspace): Choice => {
    const placed = ranking.get(workspace.machine)
    const out = rejected.get(workspace.machine)
    if (out) return { workspace, reason: WHY[out.why], asleep: true }
    return { workspace, reason: placed?.reason ?? null, asleep: false }
  })
  const score = (one: Choice) => (one.asleep ? -Infinity : (ranking.get(one.workspace.machine)?.score ?? -1))
  choices.sort((a, b) => score(b) - score(a) || a.workspace.name.localeCompare(b.workspace.name))
  return { choices, ranked: placement !== null }
}
