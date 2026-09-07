import { queryOptions } from '@tanstack/react-query'
import type {
  Attention,
  Broken,
  Listed,
  Listing,
  Looked,
  Machine,
  MachineSessions,
  Probed,
  Readiness,
  Spend,
  Transcript,
  WorkspaceStatus,
} from '@/api'
import {
  ATTENTION_SWEEP_MS,
  envelope,
  failed,
  fetchJson,
  fields,
  json,
  list,
  look,
  POLL_MS,
  SWEEP_MS,
} from '@/api/client'
import { keys, type Window } from '@/api/keys'
import type { About, Notification, SshIdentity } from '@/api/types/daemon'
import type { Connection, Repo } from '@/api/types/github'

const workspace = (name: string, tail: string) =>
  `/api/workspaces/${encodeURIComponent(name)}/${tail}`
const machine = (name: string, tail: string) =>
  `/api/machines/${encodeURIComponent(name)}/${tail}`

/** A class the daemon sweeps: served from its snapshot, polled to keep the age
 *  ticking, and fresh for as long as the sweep that made it. */
function swept<T>(
  queryKey: readonly unknown[],
  path: string,
  staleTime = SWEEP_MS,
  refetchInterval = POLL_MS,
) {
  return queryOptions({
    queryKey,
    queryFn: ({ signal }) => look<T>(path, signal),
    staleTime,
    refetchInterval,
  })
}

/** The two classes on the daemon's 300 s clock: asked every 30 s, since 5 s
 *  buys nothing there but a request. */
const SLOW_POLL_MS = SWEEP_MS

/** A read a person asked for, which costs an ssh round trip
 *  ([ADR-0019](../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md)):
 *  never on a timer, never on a focus, never retried — a failed one has already
 *  spent a `ConnectTimeout`, and D4 §2 is about not making a person wait. Held
 *  until `refetch` or `fetchQuery` asks again. */
const onRequest = {
  enabled: false,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnMount: false,
  refetchOnReconnect: false,
} as const

export const machinesQuery = () =>
  swept<Machine[]>(keys.machines(), '/api/machines')
export const workspacesQuery = () =>
  swept<Listed[]>(keys.workspaces(), '/api/workspaces')
export const sessionsQuery = () =>
  swept<MachineSessions[]>(keys.sessions(), '/api/sessions')
export const readinessQuery = () =>
  swept<Readiness[]>(keys.readiness(), '/api/readiness')
export const machineReadinessQuery = (name: string) =>
  swept<Readiness>(keys.readiness(name), machine(name, 'readiness'))
/** On the daemon's 300 s clock rather than the 30 s sweep, which is why the
 *  band that draws it stamps itself (D6 §2). */
export const attentionQuery = () =>
  swept<Attention>(keys.attention(), '/api/attention', ATTENTION_SWEEP_MS, SLOW_POLL_MS)

// Y-084's route is the one that answers something other than 200, and its 404
// says the agent look has not seen a name the workspaces look has.
export const MISSING = 'missing'
export type OneAgent = Looked<WorkspaceStatus> | typeof MISSING

async function lookAtAgent(
  path: string,
  signal: AbortSignal,
): Promise<OneAgent> {
  try {
    const response = await fetch(path, { signal })
    if (response.status === 404) return MISSING
    if (!response.ok) return failed(`${path} answered ${response.status}`)
    return await envelope<WorkspaceStatus>(response, path)
  } catch (cause) {
    if (signal.aborted) throw cause
    return failed(String(cause))
  }
}

export const statusQuery = (name: string) =>
  queryOptions({
    queryKey: keys.status(name),
    queryFn: ({ signal }) => lookAtAgent(workspace(name, 'status'), signal),
    staleTime: SWEEP_MS,
    refetchInterval: POLL_MS,
  })

/** `POST …/tokens` reads a whole transcript over ssh, and the page stamps its
 *  own arrival (D3 §11.4). Never fresh: every ask is a new read. */
export const spendQuery = (name: string) =>
  queryOptions({
    queryKey: keys.spend(name),
    queryFn: ({ signal }) =>
      fetchJson<Spend>(workspace(name, 'tokens'), { method: 'POST', signal }),
    staleTime: 0,
    ...onRequest,
  })

/** One window of `POST …/logs` (Y-307). The file grows under it, so a window
 *  is never fresh and the page, not the cache, holds what has been read. */
export const transcriptQuery = (name: string, window: Window) =>
  queryOptions({
    queryKey: keys.transcript(name, window),
    queryFn: ({ signal }) =>
      fetchJson<Transcript>(workspace(name, 'logs'), {
        method: 'POST',
        signal,
        ...json(window),
      }),
    staleTime: 0,
    ...onRequest,
  })

/** `GET …/repair` answers 409 for a file that loads, so opening it is itself
 *  the question *is this broken*. The file changes when the page changes it,
 *  and a refetch under a half-typed repair is an argument the browser cannot
 *  win. */
export const repairQuery = (name: string) =>
  queryOptions({
    queryKey: keys.repair(name),
    queryFn: ({ signal }) =>
      fetchJson<Broken>(workspace(name, 'repair'), { signal }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

/** One level of a machine's filesystem (D4 §3). Kept for as long as the page
 *  is open, so walking back up costs nothing; `null` asks for `$HOME`. */
export const dirsQuery = (name: string, path: string | null) =>
  queryOptions({
    queryKey: keys.dirs(name, path),
    queryFn: ({ signal }) =>
      fetchJson<Listing>(machine(name, 'dirs'), {
        method: 'POST',
        signal,
        ...json(path === null ? {} : { path }),
      }),
    staleTime: Infinity,
    ...onRequest,
  })

/** Taking a directory always probes it, even one just listed: the listing
 *  says it is there, not what origin it holds. */
export const probeQuery = (name: string, path: string) =>
  queryOptions({
    queryKey: keys.probe(name, path),
    queryFn: ({ signal }) =>
      fetchJson<Probed>(machine(name, 'probe'), {
        method: 'POST',
        signal,
        ...json({ path }),
      }),
    staleTime: 0,
    ...onRequest,
  })

// The reads below are Y-342's and Y-343's. Their envelopes are read from
// docs/plans/m14-rust-inventory.md §2, and the Rust rows settle them.

/** Y-342. Daemon state rather than a look, so no envelope. */
export const githubQuery = () =>
  queryOptions({
    queryKey: keys.github(),
    queryFn: ({ signal }) =>
      fetchJson<Connection>('/api/github', { signal }, fields('connected', 'login', 'scopes')),
    staleTime: SWEEP_MS,
    refetchInterval: POLL_MS,
  })

/** Y-342. Swept on `attention`'s clock — it leaves the tailnet. */
export const reposQuery = () =>
  swept<Repo[]>(keys.repos(), '/api/repos', ATTENTION_SWEEP_MS, SLOW_POLL_MS)

/** Y-343. An in-memory ring buffer, polled like the fleet: cheap, and it is
 *  what a bell counts. */
export const notificationsQuery = () =>
  queryOptions({
    queryKey: keys.notifications(),
    queryFn: ({ signal }) =>
      fetchJson<Notification[]>('/api/notifications', { signal }, list),
    staleTime: SWEEP_MS,
    refetchInterval: POLL_MS,
  })

/** Y-343. `uptime_seconds` moves, so it is not held forever. */
export const aboutQuery = () =>
  queryOptions({
    queryKey: keys.about(),
    queryFn: ({ signal }) =>
      fetchJson<About>('/api/about', { signal }, fields('version', 'uptime_seconds', 'listening_on')),
    staleTime: SWEEP_MS,
  })

/** Y-343. A key on disk changes with a restart and not before. */
export const sshIdentityQuery = () =>
  queryOptions({
    queryKey: keys.sshIdentity(),
    queryFn: ({ signal }) =>
      fetchJson<SshIdentity>('/api/ssh-identity', { signal }),
    staleTime: Infinity,
  })
