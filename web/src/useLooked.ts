import { useEffect, useState } from 'react'
import type {
  Listed,
  Looked,
  MachineSessions,
  Workspace,
  WorkspaceStatus,
} from './api'
import type { AgentRow } from './columns'

// The daemon refreshes every 30 s, so this buys no fresher data — it keeps the
// age on screen ticking.
const POLL_MS = 5_000

const failed = (error: string) =>
  ({ looked: 'failed', age_seconds: 0, error }) as const

// Outside the hook because the React Compiler bails out of any function whose
// try/catch holds a conditional, and this one needs both. Null means aborted.
async function look<T>(
  path: string,
  signal: AbortSignal,
): Promise<Looked<T> | null> {
  try {
    const response = await fetch(path, { signal })
    // Every fleet state answers 200, so a non-200 is a fact about this browser
    // reaching the daemon and never about the fleet's health.
    if (!response.ok) return failed(`${path} answered ${response.status}`)
    return (await response.json()) as Looked<T>
  } catch (cause) {
    return signal.aborted ? null : failed(String(cause))
  }
}

/** Never throws: a dead daemon becomes the same `failed` envelope the daemon
 *  itself produces, so the page has one failure path rather than two. */
export function useLooked<T>(path: string): Looked<T> {
  const [answer, setAnswer] = useState<Looked<T>>({ looked: 'never' })

  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      const next = await look<T>(path, abort.signal)
      if (!next) return
      setAnswer(next)
      timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()

    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [path])

  return answer
}

// Y-084's route is the one that answers something other than 200, and its 404
// says the agent look has not seen a name the workspaces look has.
const MISSING = 'missing'
type OneAgent = Looked<WorkspaceStatus> | typeof MISSING

async function lookAtAgent(
  name: string,
  signal: AbortSignal,
): Promise<OneAgent> {
  const path = `/api/workspaces/${encodeURIComponent(name)}/status`
  try {
    const response = await fetch(path, { signal })
    if (response.status === 404) return MISSING
    if (!response.ok) return failed(`${path} answered ${response.status}`)
    return (await response.json()) as Looked<WorkspaceStatus>
  } catch (cause) {
    return failed(String(cause))
  }
}

/** One reading answered N times, so the answers collapse back into it — and a
 *  name missing from it is that row's state, not the class failing. */
function collapse(
  answers: { name: string; answer: OneAgent }[],
): Looked<Record<string, WorkspaceStatus | null>> {
  const found: Record<string, WorkspaceStatus | null> = {}
  let age_seconds = 0
  let looked = false

  for (const { name, answer } of answers) {
    if (answer === MISSING) {
      found[name] = null
      continue
    }
    if (answer.looked !== 'ok') return answer
    found[name] = answer.data
    age_seconds = Math.max(age_seconds, answer.age_seconds)
    looked = true
  }

  return looked
    ? { looked: 'ok', age_seconds, data: found }
    : { looked: 'never' }
}

/** The agent class, which `/api` names one workspace at a time. The list to ask
 *  for is the workspaces class, so a look that failed there is not seen past. */
export function useAgents(workspaces: Looked<Workspace[]>): Looked<AgentRow[]> {
  // A name's charset excludes a newline (I-2), so this is a dependency that
  // changes when the list does rather than when the poll replaces the object.
  const asked =
    workspaces.looked === 'ok'
      ? workspaces.data.map((one) => one.name).join('\n')
      : ''
  const [answer, setAnswer] = useState<
    Looked<Record<string, WorkspaceStatus | null>>
  >({ looked: 'never' })

  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      const names = asked === '' ? [] : asked.split('\n')
      const answers = await Promise.all(
        names.map(async (name) => ({
          name,
          answer: await lookAtAgent(name, abort.signal),
        })),
      )
      if (abort.signal.aborted) return
      setAnswer(collapse(answers))
      timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()

    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [asked])

  if (workspaces.looked !== 'ok') return workspaces
  if (answer.looked !== 'ok') return answer
  return {
    looked: 'ok',
    age_seconds: answer.age_seconds,
    data: workspaces.data.map((workspace) => ({
      workspace,
      status: answer.data[workspace.name] ?? null,
    })),
  }
}

/** The entries that are workspaces. Everything downstream acts on one — an edit
 *  form, a row's buttons, a session's command, a per-workspace status fetch —
 *  and a file that did not load is not something any of them can be asked
 *  about. */
export function loaded(listed: Looked<Listed[]>): Looked<Workspace[]> {
  if (listed.looked !== 'ok') return listed
  return {
    ...listed,
    data: listed.data.flatMap((one) => (one.loaded === 'yes' ? [one] : [])),
  }
}

/** The machines the next sweep will pay an ssh timeout for — Y-100's evidence
 *  that an age near the threshold is ordinary rather than a refresh that died. */
export function sessionsWaiting(sessions: Looked<MachineSessions[]>): string[] {
  return sessions.looked === 'ok'
    ? sessions.data.flatMap((answer) =>
        answer.reached === 'no' ? [answer.machine] : [],
      )
    : []
}

/** The same for the agent class, which reaches the same machines and pays the
 *  same timeout — deduplicated, since it answers per workspace. */
export function agentsWaiting(agents: Looked<AgentRow[]>): string[] {
  if (agents.looked !== 'ok') return []
  return [
    ...new Set(
      agents.data.flatMap((row) =>
        row.status?.reached === 'no' ? [row.status.machine] : [],
      ),
    ),
  ]
}
