import { useQueries, useQuery } from '@tanstack/react-query'
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
// try/catch holds a conditional, and this one needs both.
async function look<T>(path: string, signal: AbortSignal): Promise<Looked<T>> {
  try {
    const response = await fetch(path, { signal })
    // Every fleet state answers 200, so a non-200 is a fact about this browser
    // reaching the daemon and never about the fleet's health.
    if (!response.ok) return failed(`${path} answered ${response.status}`)
    return (await response.json()) as Looked<T>
  } catch (cause) {
    // Rethrown rather than made an envelope, so Query reads the unmount as the
    // cancellation it is instead of caching a failure nobody will see.
    if (signal.aborted) throw cause
    return failed(String(cause))
  }
}

/** D3 §7.1, the sharpest finding in that document: a question not yet asked was
 *  not answered *never*. This returned `{ looked: 'never' }` before the first
 *  fetch resolved, and `Section` drew that as "Not looked at yet." — so a page
 *  opening for the first time claimed the daemon had never looked at the fleet.
 *  That is R-23 broken inside the browser.
 *
 *  `pending` is a fourth state and not a fourth word: it is this browser's, the
 *  other three are the daemon's, and only a surface knows how to draw it. */
export type Reading<T> = Looked<T> | { looked: 'pending' }

/** Never throws: a dead daemon becomes the same `failed` envelope the daemon
 *  itself produces, so the page has one failure path rather than two — and
 *  Query's own `isError` is therefore a state this page cannot reach. */
export function useLooked<T>(path: string): Reading<T> {
  const { data } = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => look<T>(path, signal),
    refetchInterval: POLL_MS,
  })
  // `look` never resolves undefined, so undefined is the first fetch in flight.
  return data ?? { looked: 'pending' }
}

// Y-084's route is the one that answers something other than 200, and its 404
// says the agent look has not seen a name the workspaces look has.
const MISSING = 'missing'
type OneAgent = Looked<WorkspaceStatus> | typeof MISSING

const agentPath = (name: string) =>
  `/api/workspaces/${encodeURIComponent(name)}/status`

async function lookAtAgent(
  name: string,
  signal: AbortSignal,
): Promise<OneAgent> {
  const path = agentPath(name)
  try {
    const response = await fetch(path, { signal })
    if (response.status === 404) return MISSING
    if (!response.ok) return failed(`${path} answered ${response.status}`)
    return (await response.json()) as Looked<WorkspaceStatus>
  } catch (cause) {
    if (signal.aborted) throw cause
    return failed(String(cause))
  }
}

/** One reading answered N times, so the answers collapse back into it — and a
 *  name missing from it is that row's state, not the class failing. */
function collapse(
  answers: { name: string; answer: OneAgent | undefined }[],
): Reading<Record<string, WorkspaceStatus | null>> {
  const found: Record<string, WorkspaceStatus | null> = {}
  let age_seconds = 0
  let looked = false

  for (const { name, answer } of answers) {
    // A name still in flight is not a name with no report, so the class waits
    // for all of them — which is what one `Promise.all` used to say.
    if (answer === undefined) return { looked: 'pending' }
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
export function useAgents(
  workspaces: Reading<Workspace[]>,
): Reading<AgentRow[]> {
  const names =
    workspaces.looked === 'ok' ? workspaces.data.map((one) => one.name) : []
  const results = useQueries({
    queries: names.map((name) => ({
      queryKey: [agentPath(name)],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        lookAtAgent(name, signal),
      refetchInterval: POLL_MS,
    })),
  })
  const answer = collapse(
    results.map((result, index) => ({
      name: names[index],
      answer: result.data,
    })),
  )

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
export function loaded(listed: Reading<Listed[]>): Reading<Workspace[]> {
  if (listed.looked !== 'ok') return listed
  return {
    ...listed,
    data: listed.data.flatMap((one) => (one.loaded === 'yes' ? [one] : [])),
  }
}

/** The machines the next sweep will pay an ssh timeout for — Y-100's evidence
 *  that an age near the threshold is ordinary rather than a refresh that died. */
export function sessionsWaiting(sessions: Reading<MachineSessions[]>): string[] {
  return sessions.looked === 'ok'
    ? sessions.data.flatMap((answer) =>
        answer.reached === 'no' ? [answer.machine] : [],
      )
    : []
}

/** The same for the agent class, which reaches the same machines and pays the
 *  same timeout — deduplicated, since it answers per workspace. */
export function agentsWaiting(agents: Reading<AgentRow[]>): string[] {
  if (agents.looked !== 'ok') return []
  return [
    ...new Set(
      agents.data.flatMap((row) =>
        row.status?.reached === 'no' ? [row.status.machine] : [],
      ),
    ),
  ]
}
