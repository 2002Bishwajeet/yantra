import { useEffect, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import {
  type QueryClient,
  useQueries,
  useQuery,
  useQueryClient,
  useQueryErrorResetBoundary,
  type UseQueryOptions,
} from '@tanstack/react-query'
import type {
  Listed,
  Looked,
  MachineSessions,
  Transcript,
  Turn,
  Workspace,
  WorkspaceStatus,
} from '@/api'
import type { Reading } from '@/api/client'
import { isApiError } from '@/api/errors'
import {
  aboutQuery,
  attentionQuery,
  githubQuery,
  machineReadinessQuery,
  machinesQuery,
  MISSING,
  notificationsQuery,
  type OneAgent,
  readinessQuery,
  reposQuery,
  sessionsQuery,
  spendQuery,
  sshIdentityQuery,
  statusQuery,
  transcriptQuery,
  workspacesQuery,
} from '@/api/queries'
import type { AgentRow } from '@/columns'
import type { Asked } from '@/lib/spend'

export type { Reading } from '@/api/client'

/** `look` never resolves undefined, so undefined is the first fetch in flight. */
function useReading<T>(
  options: UseQueryOptions<Looked<T>, Error, Looked<T>, readonly unknown[]>,
): Reading<T> {
  const { data } = useQuery(options)
  return data ?? { looked: 'pending' }
}

export const useMachines = () => useReading(machinesQuery())
export const useWorkspaces = () => useReading(workspacesQuery())
export const useSessions = () => useReading(sessionsQuery())
export const useReadiness = () => useReading(readinessQuery())
export const useMachineReadiness = (machine: string) =>
  useReading(machineReadinessQuery(machine))
export const useAttention = () => useReading(attentionQuery())

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
    queries: names.map((name) => statusQuery(name)),
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

// Outside the hooks because the React Compiler bails out of any function whose
// try/catch holds a conditional, and these need both.
async function readSpend(
  client: QueryClient,
  workspace: Workspace,
): Promise<Asked> {
  try {
    const spend = await client.fetchQuery(spendQuery(workspace.name))
    return { asked: 'read', workspace, spend, at: new Date().toISOString() }
  } catch (cause) {
    const status = isApiError(cause) ? (cause.status ?? null) : null
    const said = isApiError(cause) ? cause.said : String(cause)
    // The daemon's 409: a transcript that is not there, or one with no turn in
    // it yet. Neither is a failure, so neither is drawn as one.
    if (status === 409) return { asked: 'nothing', workspace, said }
    return { asked: 'refused', workspace, status, said }
  }
}

/** One workspace's spend, read on request (D5 §6.1). `/usage` calls it with the
 *  workspace its picker chose; `/w/{name}` calls it with the one in the URL.
 *
 *  **On `/w/{name}` it lives above the tab.** Only the open tab is mounted (D5
 *  §3.5), so a tab holding its own answer would spend a second ssh every time a
 *  reader came back from the terminal. Nothing is fetched until `ask` is
 *  called. */
export function useSpend() {
  const client = useQueryClient()
  const [asked, setAsked] = useState<Asked>({ asked: 'no' })

  const ask = async (workspace: Workspace) => {
    setAsked({ asked: 'asking', workspace })
    setAsked(await readSpend(client, workspace))
  }

  return { asked, ask }
}

/** How many **records** one read asks for — D5 §4.4's window and the daemon's
 *  own default. Records are not turns: fifty of them measured as forty-one
 *  (§2.3), so this page counts records and never promises turns. */
export const LINES = 50

/** What the page holds, and nothing before the first read.
 *
 *  **It lives above the tab.** Only the open tab is mounted (D5 §3.5), and
 *  switching to the terminal and back may not spend a second ssh (§4.3). */
export type Said =
  | { said: 'no' }
  | { said: 'reading' }
  | {
      said: 'held'
      /** From the **first** read. A later one that disagrees is §4.4's moved
       *  ground rather than a newer number to adopt. */
      total: number
      /** Records asked for so far, which is what the count line reports. */
      asked: number
      /** Oldest first. `Older` prepends a disjoint window and stitches
       *  nothing. */
      turns: Turn[]
      at: string
      /** An `Older` read in flight. */
      paging: boolean
      moved: boolean
    }
  | Failed

/** The daemon's 409 — no transcript, or one with no turn in it yet — and every
 *  other way a read does not happen. Neither 409 is a failure, so neither is
 *  drawn as one (D5 §4.5). */
type Failed =
  | { said: 'nothing'; because: string }
  | { said: 'refused'; status: number | null; because: string }

type Answer = { read: Transcript; at: string } | Failed

async function readWindow(
  client: QueryClient,
  name: string,
  lines: number,
  before: number,
): Promise<Answer> {
  try {
    const read = await client.fetchQuery(
      transcriptQuery(name, { lines, before }),
    )
    return { read, at: new Date().toISOString() }
  } catch (cause) {
    const status = isApiError(cause) ? (cause.status ?? null) : null
    const because = isApiError(cause) ? cause.said : String(cause)
    if (status === 409) return { said: 'nothing', because }
    return { said: 'refused', status, because }
  }
}

function merge(
  held: Said,
  answer: Answer,
  lines: number,
  before: number,
): Said {
  // One failure path, as `/usage` has: a read that could not be made replaces
  // what is on screen rather than annotating it.
  if (!('read' in answer)) return answer

  const { read, at } = answer
  const asked = Math.min(before + lines, read.total)
  if (before === 0 || held.said !== 'held') {
    return {
      said: 'held',
      total: read.total,
      asked,
      turns: read.turns,
      at,
      paging: false,
      moved: false,
    }
  }

  // D5 §4.4: the ground moved. The window is counted from the end of a file
  // that has grown, so it no longer lines up with what is drawn — and a reader
  // could never detect the overlap or the gap that stitching would produce.
  if (read.total > held.total) return { ...held, paging: false, moved: true }

  return {
    ...held,
    // The windows are disjoint, so this prepends and stitches nothing. `at`
    // stays the newest read's: an older window says nothing about how fresh
    // the newest turn on the page is.
    turns: [...read.turns, ...held.turns],
    asked,
    paging: false,
  }
}

/** The transcript of one workspace, read on request (D5 §4.3). Called by the
 *  page rather than by the tab, so the answer outlives a switch to the
 *  terminal; nothing is fetched until `read` is called. */
export function useTranscript(name: string) {
  const client = useQueryClient()
  const [said, setSaid] = useState<Said>({ said: 'no' })

  const read = async (lines: number, before: number) => {
    setSaid((held) =>
      before === 0
        ? { said: 'reading' }
        : held.said === 'held'
          ? { ...held, paging: true }
          : held,
    )
    const answer = await readWindow(client, name, lines, before)
    setSaid((held) => merge(held, answer, lines, before))
  }

  return { said, read }
}

/** How often an open tab says so. Half of `WATCHED` in
 *  [`crates/yantrad/src/notify.rs`](../../../crates/yantrad/src/notify.rs), so
 *  one beacon lost to a flaky network does not start a push to a phone the
 *  person is holding. */
const BEACON_MS = 20_000

/** D3 §13. **The page says it is being looked at; the daemon stops pushing what
 *  the page is already showing.**
 *
 *  It is an explicit beacon rather than "any `/api` read means presence",
 *  because a background tab polls every 5 s and is not a person watching. The
 *  Page Visibility API is what tells the two apart, and it is the only thing
 *  that does — a phone locked with the tab open fires `visibilitychange`.
 *
 *  **A failure is silence, not an error.** The worst it costs is a notification
 *  you were going to get anyway, and a banner about it would be noise on every
 *  page. */
export function useViewing() {
  useEffect(() => {
    let stop = false

    const beacon = () => {
      if (stop || document.visibilityState !== 'visible') return
      void fetch('/api/viewing', { method: 'POST' }).catch(() => {})
    }

    beacon()
    const timer = setInterval(beacon, BEACON_MS)
    document.addEventListener('visibilitychange', beacon)
    return () => {
      stop = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', beacon)
    }
  }, [])
}

/** What an `ErrorBoundary` around a route spreads, so a navigation clears both
 *  the boundary and Query's own error state — otherwise the next page opens on
 *  the last page's failure:
 *  `<ErrorBoundary FallbackComponent={…} {...useResetOnRouteChange()}>`. */
export function useResetOnRouteChange() {
  const { reset } = useQueryErrorResetBoundary()
  // The *resolved* location, not `useLocation`: that one moves the moment a
  // navigation starts, while the failed page is still the one mounted — so the
  // boundary would reset onto it and it would ask the daemon again for nothing.
  const pathname = useRouterState({
    select: (state) => state.resolvedLocation?.pathname ?? state.location.pathname,
  })
  return { resetKeys: [pathname], onReset: reset }
}

// Y-342 and Y-343 serve these. Bare reads answer Query's own result rather
// than a `Reading`, since nothing about them was looked at over ssh.

export const useGithub = () => useQuery(githubQuery())
export const useRepos = () => useReading(reposQuery())
export const useNotifications = () => useQuery(notificationsQuery())
export const useAbout = () => useQuery(aboutQuery())
export const useSshIdentity = () => useQuery(sshIdentityQuery())
