import { keepPreviousData, type QueryClient, queryOptions, useQuery, useQueries } from '@tanstack/react-query'
import type {
  Attention,
  Broken,
  Check,
  Commands,
  Connection,
  Listed,
  Listing,
  Looked,
  Machine,
  MachineSessions,
  MachineThread,
  Mentions,
  Probed,
  Readiness,
  Repo,
  Room,
  RoomSummary,
  Spend,
  ThreadFound,
  ThreadState,
  Transcript,
  WorkspaceStatus,
} from '@/api'
import {
  ATTENTION_SWEEP_MS,
  envelope,
  failed,
  fetchJson,
  fields,
  held,
  json,
  look,
  NOT_REACHED,
  POLL_MS,
  SWEEP_MS,
  type Shape,
  unanswered,
  unreached,
} from '@/api/client'
import { type ApiError, isApiError } from '@/api/errors'
import { keys, type Window } from '@/api/keys'
import type { Here } from '@/api'
import type { About, Notification, SshIdentity } from '@/api/types/daemon'

const workspace = (name: string, tail: string) =>
  `/api/workspaces/${encodeURIComponent(name)}/${tail}`
const machine = (name: string, tail: string) =>
  `/api/machines/${encodeURIComponent(name)}/${tail}`

/** What every `held` read sets. The poll is the retry, so a dead daemon is
 *  asked on one clock. A tab that is seen again asks at once, whatever the
 *  age of its reading, because the reads it missed are the ones that fail. */
const polled = { retry: false, refetchOnWindowFocus: 'always' } as const

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
    queryFn: held(({ signal }) => look<T>(path, signal), refetchInterval),
    staleTime,
    refetchInterval,
    ...polled,
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
/** A 404 is a machine no check has reached yet, which is `never` and not a
 *  daemon that was not reached (D7 S4). A machine with a kept check never 404s,
 *  so a poll cannot turn a result into `never` (Y-579). */
export const machineReadinessQuery = (name: string) =>
  queryOptions({
    // Widened as `swept` widens it, so `useReading` takes it.
    queryKey: keys.readiness(name) as readonly unknown[],
    queryFn: held(async ({ signal }): Promise<Looked<Readiness>> => {
      const path = machine(name, 'readiness')
      try {
        const response = await fetch(path, { signal })
        if (response.status === 404) return { looked: 'never' }
        if (!response.ok) return await unanswered(response)
        return await envelope<Readiness>(response, path)
      } catch (cause) {
        if (signal.aborted) throw cause
        return unreached(failed(`${NOT_REACHED}: ${String(cause)}`))
      }
    }),
    staleTime: SWEEP_MS,
    refetchInterval: POLL_MS,
    ...polled,
  })
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
    if (!response.ok) return unreached(failed(`${path} answered ${response.status}`))
    return await envelope<WorkspaceStatus>(response, path)
  } catch (cause) {
    if (signal.aborted) throw cause
    return unreached(failed(String(cause)))
  }
}

export const statusQuery = (name: string) =>
  queryOptions({
    queryKey: keys.status(name),
    queryFn: held(({ signal }) => lookAtAgent(workspace(name, 'status'), signal)),
    staleTime: SWEEP_MS,
    refetchInterval: POLL_MS,
    ...polled,
  })

/** Try again, from any surface: every read is asked again, and so is a status
 *  read the workspace list unlocks — the person tapped once, and the second
 *  wave of reads is theirs too. */
export async function readAgain(client: QueryClient) {
  await client.invalidateQueries()
  await readHomesAgain(client)
  const listed = client.getQueryData(workspacesQuery().queryKey)
  if (listed?.looked !== 'ok') return
  const names = listed.data.map((one) => one.name)
  // A held read rejects, and the reading it keeps is the answer.
  await Promise.all(names.map((name) => client.fetchQuery(statusQuery(name)).catch(() => undefined)))
  const failed = names.filter((name) => {
    const answer = client.getQueryData(statusQuery(name).queryKey)
    return answer !== undefined && answer !== MISSING && answer.looked === 'failed'
  })
  await Promise.all(failed.map((name) => client.refetchQueries({ queryKey: statusQuery(name).queryKey })))
}

/** The rail's home-thread reads wait for the machine list, as the status reads wait for the
 *  workspace list, so their first ask can come after the tap and fail with it. */
async function readHomesAgain(client: QueryClient) {
  const listed = client.getQueryData(machinesQuery().queryKey)
  if (listed?.looked !== 'ok') return
  const reads = listed.data.map((one) => machineThreadsQuery(one.name))
  await Promise.all(reads.map((read) => client.fetchQuery(read).catch(() => undefined)))
  await Promise.all(
    reads
      .filter((read) => client.getQueryState(read.queryKey)?.status === 'error')
      .map((read) => client.refetchQueries({ queryKey: read.queryKey })),
  )
}

/** `POST …/tokens` reads a whole transcript over ssh, and the page stamps its
 *  own arrival (D3 §11.4). Never fresh: every ask is a new read. `since` is an
 *  RFC 3339 instant the browser chose (Y-354); without it the POST has no body,
 *  which the daemon reads as the whole session. */
export const spendQuery = (name: string, since?: string) =>
  queryOptions({
    queryKey: keys.spend(name, since),
    queryFn: ({ signal }) =>
      fetchJson<Spend>(workspace(name, 'tokens'), {
        method: 'POST',
        signal,
        ...(since === undefined ? {} : json({ since })),
      }),
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

/** Y-562. What the composer offers after `@` and `$`: one ssh round trip, asked
 *  when a trigger opens (ADR-0019). Held for a few minutes, so typing more of a
 *  name or opening the menu again asks nothing. */
export const mentionsQuery = (name: string, thread: string | null, harness: string) =>
  queryOptions({
    queryKey: keys.mentions(name, thread, harness),
    queryFn: ({ signal }) =>
      fetchJson<Mentions>(
        workspace(name, 'mentions'),
        { method: 'POST', signal, ...json(thread === null ? { harness } : { harness, thread }) },
        fields('files', 'truncated', 'skills'),
      ),
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

export const useMentions = (name: string, thread: string | null, harness: string, enabled: boolean) =>
  useQuery({ ...mentionsQuery(name, thread, harness), enabled })

/** Y-649. What each thread is doing, read from the daemon's memory: no ssh and no GitHub,
 *  so it may poll (ADR-0019). It polls only while `on`, which is while the thread menu is open. */
export const useThreadStates = (name: string, on: boolean) =>
  useQuery<ThreadState[], ApiError>({
    queryKey: keys.threadStates(name),
    queryFn: ({ signal }) => fetchJson<ThreadState[]>(workspace(name, 'threads'), { signal }),
    enabled: on,
    refetchInterval: on ? 5_000 : false,
    staleTime: 0,
    retry: false,
  })

/** ADR-0046 decision 1.7: every thread the store keeps for a machine. It reads the store and
 *  asks no machine (ADR-0019), so it is a GET and never polls. */
export const machineThreadsQuery = (machine: string) =>
  queryOptions<MachineThread[], ApiError>({
    queryKey: keys.machineThreads(machine),
    queryFn: ({ signal }) => fetchJson<MachineThread[]>(`/api/machines/${encodeURIComponent(machine)}/threads`, { signal }),
    staleTime: 5_000,
    retry: false,
  })

/** Y-689. The threads whose title holds `q`, read from the daemon's store: no ssh, so a
 *  thread of an offline machine is found (ADR-0019). The last answer stays on screen
 *  while the next one loads. */
export const threadSearchQuery = (q: string) =>
  queryOptions<ThreadFound[], ApiError>({
    queryKey: keys.threadSearch(q),
    queryFn: ({ signal }) =>
      fetchJson<ThreadFound[]>(`/api/threads?q=${encodeURIComponent(q)}`, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    retry: false,
    refetchOnWindowFocus: false,
  })

export const useThreadSearch = (q: string, enabled: boolean) =>
  useQuery({ ...threadSearchQuery(q), enabled })

/** Y-563. Claude's slash commands for the composer's `/` menu, asked as
 *  {@link mentionsQuery} is: once when the trigger opens, held for a few minutes. */
export const commandsQuery = (name: string, thread: string | null, harness: string) =>
  queryOptions({
    queryKey: keys.commands(name, thread, harness),
    queryFn: ({ signal }) =>
      fetchJson<Commands>(
        workspace(name, 'commands'),
        { method: 'POST', signal, ...json(thread === null ? { harness } : { harness, thread }) },
        fields('commands'),
      ),
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

export const useCommands = (name: string, thread: string | null, harness: string, enabled: boolean) =>
  useQuery({ ...commandsQuery(name, thread, harness), enabled })

// The reads below are Y-342's and Y-343's. Their envelopes are read from
// docs/plans/m14-rust-inventory.md §2, and the Rust rows settle them.

/** Y-342. Daemon state rather than a look, so no envelope. */
export const githubQuery = () =>
  queryOptions({
    queryKey: keys.github(),
    queryFn: ({ signal }) =>
      fetchJson<Connection>(
        '/api/github',
        { signal },
        fields('connected', 'login', 'avatar_url', 'scopes', 'client_id', 'client_id_custom'),
      ),
    staleTime: SWEEP_MS,
    refetchInterval: POLL_MS,
  })

/** Y-623: what GitHub said about the grant, on the daemon's own sweep. */
export const githubReadinessQuery = () =>
  swept<Check>(keys.githubReadiness(), '/api/readiness/github')

/** Y-342. Swept on `attention`'s clock — it leaves the tailnet. */
export const reposQuery = () =>
  swept<Repo[]>(keys.repos(), '/api/repos', ATTENTION_SWEEP_MS, SLOW_POLL_MS)

/** Y-629: the organisations that own none of `/api/repos`, read on its sweep. */
export const hiddenOrgsQuery = () =>
  swept<string[]>(keys.hiddenOrgs(), '/api/repos/hidden', ATTENTION_SWEEP_MS, SLOW_POLL_MS)

/** Y-343. An in-memory ring buffer, polled like the fleet: cheap, and it is
 *  what a bell counts. api.ts has it as `Looked<Event[]>` now; the guard
 *  reads the envelope's word until this type follows. */
export const notificationsQuery = () =>
  queryOptions({
    queryKey: keys.notifications(),
    queryFn: ({ signal }) =>
      fetchJson<Notification[]>('/api/notifications', { signal }, fields('looked')),
    staleTime: SWEEP_MS,
    refetchInterval: POLL_MS,
  })

/** Y-589. Once the daemon names the device it does not change while a page is
 *  open. Until then (503 before the first tailnet look, or a failed one; or a
 *  device the list does not hold yet) it is asked again, so a phone that has
 *  just joined is named on the next look. A failure draws nothing. */
export const hereQuery = () =>
  queryOptions({
    queryKey: keys.here(),
    queryFn: ({ signal }) => fetchJson<Here>('/api/here', { signal }, fields('machine')),
    staleTime: Infinity,
    retry: false,
    refetchInterval: (query) => (query.state.data?.machine ? false : POLL_MS),
  })

/** Y-343. `uptime_seconds` moves, so it is not held forever. Y-367: polled
 *  slowly, so the hourly release reading reaches an open page. */
export const aboutQuery = () =>
  queryOptions({
    queryKey: keys.about(),
    queryFn: ({ signal }) =>
      fetchJson<About>(
        '/api/about',
        { signal },
        fields('version', 'uptime_seconds', 'listening_on', 'published'),
      ),
    staleTime: SWEEP_MS,
    refetchInterval: SLOW_POLL_MS,
  })

/** ADR-0043 §6: whether `yantra-stt` answers, read through the daemon because
 *  the HTTPS page cannot reach its tailnet address. Asked each time the Chat
 *  opens, and again after a failed utterance or a press while the box is
 *  away, never on a timer. */
export type Dictation = { state: 'off' | 'unreachable' | 'ready' }

export const dictationQuery = () =>
  queryOptions({
    queryKey: keys.dictation(),
    queryFn: ({ signal }) => fetchJson<Dictation>('/api/dictate/health', { signal }, fields('state')),
    staleTime: Infinity,
    refetchOnMount: 'always',
    retry: false,
  })

/** Y-343. The 404 is a key not made yet, and the first join makes it
 *  (ADR-0029), so `null` is an answer rather than an error: a refetch then
 *  keeps it on screen, where an error would flip back to pending (Y-390). It
 *  is asked again until the key exists, and never after. */
export const sshIdentityQuery = () =>
  queryOptions({
    queryKey: keys.sshIdentity(),
    queryFn: async ({ signal }): Promise<SshIdentity | null> => {
      try {
        return await fetchJson<SshIdentity>('/api/ssh-identity', { signal })
      } catch (cause) {
        if (isApiError(cause) && cause.kind === 'missing') return null
        throw cause
      }
    },
    staleTime: Infinity,
    refetchInterval: (query) => (query.state.data === null ? POLL_MS : false),
  })

/** Y-536. Rooms are daemon memory, not a sweep, so no envelope. Polled fast
 *  enough to read a conversation as agents write it. */
export const ROOM_POLL_MS = 3_000

const list: Shape = (body) => (Array.isArray(body) ? null : 'rooms')

export const roomsQuery = () =>
  queryOptions({
    queryKey: keys.rooms(),
    queryFn: ({ signal }) => fetchJson<RoomSummary[]>('/api/rooms', { signal }, list),
    staleTime: 0,
    refetchInterval: ROOM_POLL_MS,
  })

/** A 404 is a room never made, one that was ended, or an agent-made room that a restart lost. */
export const roomQuery = (name: string) =>
  queryOptions({
    queryKey: keys.room(name),
    queryFn: ({ signal }) =>
      fetchJson<Room>(
        `/api/rooms/${encodeURIComponent(name)}`,
        { signal },
        fields('name', 'spent', 'budget', 'paused', 'log'),
      ),
    staleTime: 0,
    refetchInterval: ROOM_POLL_MS,
  })

const homeOnly = (threads: MachineThread[]) => threads.filter((one) => one.workspace === null)

/** One machine's home threads, for the Chat header's menu. */
export const useMachineHomeThreads = (machine: string) =>
  useQuery({ ...machineThreadsQuery(machine), select: homeOnly })

export type HomeThread = { machine: string; thread: MachineThread }

export type HomeThreads =
  | { state: 'pending' }
  // The machine list failed, and every surface that needs it already says so.
  | { state: 'unknown' }
  | { state: 'ok'; threads: HomeThread[] }
  | { state: 'failed'; error: ApiError; retry: () => void }

/** Every machine's home threads, for the Sessions rail: one read per machine the list names. */
export function useHomeThreads(): HomeThreads {
  const machines = useQuery(machinesQuery())
  const names = machines.data?.looked === 'ok' ? machines.data.data.map((one) => one.name) : []
  const reads = useQueries({
    queries: names.map((name) => ({ ...machineThreadsQuery(name), select: homeOnly })),
  })

  if (machines.data !== undefined && machines.data.looked !== 'ok') return { state: 'unknown' }
  const failed = reads.find((one) => one.error)
  if (failed?.error) return { state: 'failed', error: failed.error, retry: () => reads.forEach((one) => void one.refetch()) }
  if (machines.data === undefined || reads.some((one) => one.data === undefined)) return { state: 'pending' }
  return {
    state: 'ok',
    threads: reads.flatMap((one, n) => (one.data ?? []).map((thread) => ({ machine: names[n], thread }))),
  }
}
