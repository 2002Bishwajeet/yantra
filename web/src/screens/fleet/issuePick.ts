import type { Placed, Placement, Unplaced, Workspace } from '@/api'

export type Choice = {
  workspace: Workspace
  /** Why this machine ranks where it does, or why it cannot be ranked. */
  reason: string | null
  /** The machine has no fresh beat: it stays listed, last. */
  asleep: boolean
  /** The workspace path ends in `owner/repo`. A workspace has no remote field, so
   *  false means only the folder name matched and the owner is a guess. */
  owned: boolean
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

const segments = (path: string) => path.split(/[\\/]/).filter(Boolean)
const tail = (path: string) => segments(path).pop() ?? ''
const machineKey = (machine: string) => machine.toLowerCase()

/** Same rule as placement.rs `ran_here`: the last path segment names the repo. */
export function pickWorkspaces(workspaces: Workspace[], issueRepo: string, placement: Placement | null): Picks {
  const [owner = '', wanted = ''] = issueRepo.toLowerCase().split('/')
  const matches = workspaces.filter((one) => tail(one.repo).toLowerCase() === wanted)
  const ranking = new Map<string, Placed>((placement?.ranked ?? []).map((one) => [machineKey(one.machine), one]))
  const rejected = new Map<string, Unplaced>((placement?.rejected ?? []).map((one) => [machineKey(one.machine), one]))

  const choices = matches.map((workspace): Choice => {
    const placed = ranking.get(machineKey(workspace.machine))
    const out = rejected.get(machineKey(workspace.machine))
    const owned = segments(workspace.repo).slice(-2).join('/').toLowerCase() === `${owner}/${wanted}`
    if (out) return { workspace, reason: WHY[out.why], asleep: true, owned }
    return { workspace, reason: placed?.reason ?? null, asleep: false, owned }
  })
  const score = (one: Choice) => (one.asleep ? -Infinity : (ranking.get(machineKey(one.workspace.machine))?.score ?? -1))
  choices.sort((a, b) => score(b) - score(a) || a.workspace.name.localeCompare(b.workspace.name))
  return { choices, ranked: placement !== null }
}
