import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  Change,
  Channel,
  Cloning,
  Create,
  Connection,
  Device,
  Killed,
  Listing,
  Looked,
  Opened,
  Placement,
  PlacementAsk,
  Readiness,
  Removed,
  Resumed,
  RoomPosted,
  Stopped,
  Thread,
  ThreadCommitted,
  ThreadMessage,
  ThreadOpened,
  ThreadPrMerged,
  ThreadPrOpened,
  ThreadPushed,
  ThreadTerminal,
  Workspace,
} from '@/api'
import { fetchJson, json } from '@/api/client'
import type { ApiError } from '@/api/errors'
import { keys } from '@/api/keys'

const workspace = (name: string, tail = '') =>
  `/api/workspaces/${encodeURIComponent(name)}${tail}`

/** Every write is a `useMutation` whose error is an `ApiError`, and each one
 *  invalidates what it changed and returns that refetch, so `isPending` holds
 *  until the page can draw the answer rather than the row it replaced.
 *
 *  Each `201`/`200` still carries the whole answer, and the surfaces draw
 *  that: the sweep is up to 30 s behind its own write, so a refetch alone can
 *  list what was just deleted (I-30). A create keeps its `201` under
 *  `keys.created`, and the session page draws it until the sweep lists the name. */
export function useCreateWorkspace() {
  const client = useQueryClient()
  return useMutation<Workspace, ApiError, Create>({
    mutationFn: (body) =>
      fetchJson<Workspace>('/api/workspaces', { method: 'POST', ...json(body) }),
    onSuccess: (made) => {
      client.setQueryData(keys.created(made.name), made)
      return client.invalidateQueries({ queryKey: keys.workspaces(), exact: true })
    },
  })
}

/** A field left out is left alone, and `startup: null` is `--no-startup`. */
export function useEditWorkspace() {
  const client = useQueryClient()
  return useMutation<Workspace, ApiError, { name: string; change: Change }>({
    mutationFn: ({ name, change }) =>
      fetchJson<Workspace>(workspace(name), { method: 'PATCH', ...json(change) }),
    // The prefix: the list, and the status a moved workspace now reads on
    // another machine.
    onSuccess: () => client.invalidateQueries({ queryKey: keys.workspaces() }),
  })
}

/** `force` skips the daemon's refusal to strand a live session, which is the
 *  thing worth reading — a surface sends it only where a person meant it.
 *  What was held about the name goes with it, or a mounted status would keep
 *  polling a workspace that is gone. */
export function useDeleteWorkspace() {
  const client = useQueryClient()
  return useMutation<Removed, ApiError, { name: string; force?: boolean }>({
    mutationFn: ({ name, force }) =>
      fetchJson<Removed>(workspace(name, force ? '?force=true' : ''), {
        method: 'DELETE',
      }),
    onSuccess: async (_, { name }) => {
      client.removeQueries({ queryKey: keys.workspace(name) })
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.workspaces(), exact: true }),
        client.invalidateQueries({ queryKey: keys.sessions() }),
      ])
    },
  })
}

const afterVerb = (
  client: ReturnType<typeof useQueryClient>,
  name: string,
) =>
  Promise.all([
    client.invalidateQueries({ queryKey: keys.status(name) }),
    client.invalidateQueries({ queryKey: keys.sessions() }),
  ])

/** Only `up` reads a body, and the machine is not in it: the target is
 *  `workspace.machine`, chosen when the workspace was written (Y-117). A
 *  workspace with no startup of its own is started with the agent. */
export function useUp() {
  const client = useQueryClient()
  return useMutation<Opened, ApiError, Workspace>({
    mutationFn: (one) =>
      fetchJson<Opened>(workspace(one.name, '/up'), {
        method: 'POST',
        ...json(one.startup === null ? { agent: 'claude' } : {}),
      }),
    onSuccess: (_, one) => afterVerb(client, one.name),
  })
}

export function useDown() {
  const client = useQueryClient()
  return useMutation<Stopped, ApiError, string>({
    mutationFn: (name) =>
      fetchJson<Stopped>(workspace(name, '/down'), { method: 'POST' }),
    onSuccess: (_, name) => afterVerb(client, name),
  })
}

export function useResume() {
  const client = useQueryClient()
  return useMutation<Resumed, ApiError, string>({
    mutationFn: (name) =>
      fetchJson<Resumed>(workspace(name, '/resume'), { method: 'POST' }),
    onSuccess: (_, name) => afterVerb(client, name),
  })
}

/** `killed: false` is a session that was already gone, which is the state
 *  asked for (I-30). The session may have been a workspace's, so every status
 *  is asked again along with the sessions class. */
export function useKillSession() {
  const client = useQueryClient()
  return useMutation<Killed, ApiError, { machine: string; session: string }>({
    mutationFn: ({ machine, session }) =>
      fetchJson<Killed>(
        `/api/machines/${encodeURIComponent(machine)}/sessions/${encodeURIComponent(session)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.sessions() }),
        client.invalidateQueries({ queryKey: keys.workspaces() }),
      ]),
  })
}

/** ADR-0020: refuses bytes that still will not load, naming the next error. */
export function useRepairWorkspace() {
  const client = useQueryClient()
  return useMutation<Workspace, ApiError, { name: string; text: string }>({
    mutationFn: ({ name, text }) =>
      fetchJson<Workspace>(workspace(name, '/repair'), {
        method: 'POST',
        ...json({ text }),
      }),
    onSuccess: (_, { name }) =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.workspaces(), exact: true }),
        client.invalidateQueries({ queryKey: keys.repair(name) }),
      ]),
  })
}

/** ADR-0021. The daemon writes before it sends, so a 502 is not a failed save.
 *  Nothing is read back and nothing is invalidated: no read serves the relay. */
export function useSetRelay() {
  return useMutation<void, ApiError, { url: string; token?: string }>({
    mutationFn: (body) =>
      fetchJson<void>('/api/relay', { method: 'POST', ...json(body) }),
  })
}

/** `POST …/readiness` re-asks the machine now and answers the `GET`'s own
 *  envelope at `age_seconds: 0`, so the answer goes straight into that key and
 *  into the list the Machines page reads. A poll already in flight is cancelled
 *  first, because it may have left the daemon before the check was kept.
 *  A full ssh round trip: a button, never a timer (ADR-0019). */
export function useRecheckReadiness() {
  const client = useQueryClient()
  return useMutation<Looked<Readiness>, ApiError, string>({
    mutationFn: (machine) =>
      fetchJson<Looked<Readiness>>(
        `/api/machines/${encodeURIComponent(machine)}/readiness`,
        { method: 'POST' },
      ),
    onSuccess: async (answer, machine) => {
      await client.cancelQueries({ queryKey: keys.readiness() })
      client.setQueryData(keys.readiness(machine), answer)

      const list = keys.readiness()
      const held = client.getQueryData<Looked<Readiness[]>>(list)
      if (answer.looked !== 'ok' || held?.looked !== 'ok') {
        await client.invalidateQueries({ queryKey: list, exact: true })
        return
      }
      const others = held.data.filter((report) => report.machine !== machine)
      const next: Looked<Readiness[]> = {
        looked: 'ok',
        age_seconds: answer.age_seconds,
        data: [...others, answer.data],
      }
      client.setQueryData(list, next)
    },
  })
}

/** What Install is asked to do. `mic` is ADR-0031 §1's optional item. */
export type Install = { machine: string; mic?: boolean }

/** `POST …/install` is `yantra install <machine> [--mic]`: 202 and no body,
 *  and the install runs in the background (ADR-0028 §4). Its result is an
 *  `installed` or `install_stopped` event in `/api/notifications`, so nothing
 *  is invalidated here. A 409 is an install already running on that machine. */
export function useInstall() {
  return useMutation<void, ApiError, Install>({
    mutationFn: ({ machine, mic }) =>
      fetchJson<void>(`/api/machines/${encodeURIComponent(machine)}/install${mic ? '?mic=true' : ''}`, {
        method: 'POST',
      }),
  })
}

/** Step 1 of the device flow: the code to type and where. The daemon polls
 *  GitHub itself, so there is no poll write; `useGithub()` says when the
 *  grant is held. A 409 is a flow already waiting for its code. */
export function useGithubLogin() {
  const client = useQueryClient()
  return useMutation<Device, ApiError, void>({
    mutationFn: () => fetchJson<Device>('/api/github/login', { method: 'POST' }),
    // Until the next poll, a grant held from before is not the new sign-in.
    onSuccess: () =>
      client.setQueryData<Connection>(keys.github(), (held) => (held ? { ...held, pending: true } : held)),
  })
}

/** Drops the grant from memory and the env file; `/api/github` reads back
 *  `connected: false` and the sweep that needs it fails on its next clock. */
export function useGithubLogout() {
  const client = useQueryClient()
  return useMutation<void, ApiError, void>({
    mutationFn: () => fetchJson<void>('/api/github', { method: 'DELETE' }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.github() }),
        client.invalidateQueries({ queryKey: keys.attention() }),
        client.invalidateQueries({ queryKey: keys.repos() }),
      ]),
  })
}

/** Y-393: a self-hoster's own OAuth App instead of the one this build
 *  carries. Same shape as `useSetRelay` and for the same reason — the daemon
 *  takes it at its next restart, so nothing here is invalidated: a refetch
 *  now would still read the id `yantrad` started with. */
export function useSetGithubClientId() {
  return useMutation<void, ApiError, { id: string }>({
    mutationFn: (body) =>
      fetchJson<void>('/api/github/client-id', { method: 'POST', ...json(body) }),
  })
}

/** Removes the override, falling back to the build's own id at the next
 *  restart. Nothing invalidated, for the reason above. */
export function useClearGithubClientId() {
  return useMutation<void, ApiError, void>({
    mutationFn: () => fetchJson<void>('/api/github/client-id', { method: 'DELETE' }),
  })
}

/** `POST /api/update` is `yantra update` (ADR-0027 §3): 202 and no body. The
 *  daemon only asks; a root unit installs the release and restarts it, so
 *  the answer arrives as a new `version` on `/api/about`. A 409 is a box with
 *  no updater, and its sentence names install.sh. */
export function useApplyUpdate() {
  return useMutation<void, ApiError, void>({
    mutationFn: () => fetchJson<void>('/api/update', { method: 'POST' }),
  })
}

/** Y-662: `PUT /api/update/channel` → 204. The daemon rewrites the channel the
 *  update unit reads and wakes its release look, so About is read again. A 409
 *  is a box whose updater has not yet made the channel file. */
export function useSetChannel() {
  const client = useQueryClient()
  return useMutation<void, ApiError, Channel>({
    mutationFn: (channel) => fetchJson<void>('/api/update/channel', { method: 'PUT', ...json({ channel }) }),
    onSettled: () => client.invalidateQueries({ queryKey: keys.about(), exact: true }),
  })
}

// ---- Y-349: clone and mkdir, for New session (Y-344's routes) ----

/** `POST /api/machines/{m}/clone` → 202 with the tmux session `git clone`
 *  runs in. Nothing is awaited: progress is that session's terminal socket,
 *  and completion is `probeQuery` on `path`. Asking twice attaches (I-30).
 *  The session is the one thing that exists at 202, so it is the one key. */
export function useClone() {
  const client = useQueryClient()
  return useMutation<Cloning, ApiError, { machine: string; url: string; path: string }>({
    mutationFn: ({ machine, url, path }) =>
      fetchJson<Cloning>(`/api/machines/${encodeURIComponent(machine)}/clone`, {
        method: 'POST',
        ...json({ url, path }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.sessions(), exact: true }),
  })
}

/** `POST …/dirs` with `make`: one directory under `path`, answered with the
 *  listing that now holds it — which goes straight into that level's key. */
export function useMakeDir() {
  const client = useQueryClient()
  return useMutation<Listing, ApiError, { machine: string; path: string; make: string }>({
    mutationFn: ({ machine, path, make }) =>
      fetchJson<Listing>(`/api/machines/${encodeURIComponent(machine)}/dirs`, {
        method: 'POST',
        ...json({ path, make }),
      }),
    onSuccess: (listing, { machine, path }) =>
      client.setQueryData(keys.dirs(machine, path), listing),
  })
}

// ---- end Y-349 ----

// Y-517: a read reached over a POST (ADR-0019), so a mutation: a person picked
// the source, and nothing polls it. It writes nothing, so it invalidates nothing.
export function usePlacement() {
  return useMutation<Placement, ApiError, PlacementAsk>({
    mutationFn: (ask) => fetchJson<Placement>('/api/placement', { method: 'POST', ...json(ask) }),
  })
}

// Y-489: the thread routes of Y-488. Both reach git over ssh, so they are POSTs
// a person asks for, and neither polls (ADR-0019).

/** `POST …/threads`: the workspace's threads with their PR state. Asked on
 *  mount and by Refresh. 404, 502 (GitHub) and 503 (machine) come back typed. */
export function useThreads(name: string) {
  return useMutation<Thread[], ApiError, void>({
    mutationFn: () => fetchJson<Thread[]>(workspace(name, '/threads'), { method: 'POST' }),
  })
}

/** `POST …/threads/new`: a worktree and branch for `owner/repo#n`, and the
 *  composer's first text. 400 is not an issue, 409 is no grant. */
export function useOpenThread(name: string) {
  return useMutation<ThreadOpened, ApiError, string>({
    mutationFn: (issue) =>
      fetchJson<ThreadOpened>(workspace(name, '/threads/new'), { method: 'POST', ...json({ issue }) }),
  })
}

// Y-493: the four git verbs on a thread (Y-492, Y-449). Each reaches git or
// GitHub, so each is a POST a person asks for and none polls (ADR-0019).
const thread = (name: string, id: string, verb: string) => workspace(name, `/threads/${encodeURIComponent(id)}/${verb}`)

/** `…/message`: `claude -p` drafts a commit message on the machine. 409 is a
 *  running turn, 502 `claude` failed, 504 it timed out. */
export function useDraftMessage(name: string) {
  return useMutation<ThreadMessage, ApiError, string>({
    mutationFn: (id) => fetchJson<ThreadMessage>(thread(name, id, 'message'), { method: 'POST' }),
  })
}

/** `…/commit`. 400 is an empty message, 409 no git identity or nothing to commit. */
export function useCommit(name: string) {
  return useMutation<ThreadCommitted, ApiError, { id: string; message: string }>({
    mutationFn: ({ id, message }) =>
      fetchJson<ThreadCommitted>(thread(name, id, 'commit'), { method: 'POST', ...json({ message }) }),
  })
}

/** `…/push`. 409 is a refused push or no remote. */
export function usePush(name: string) {
  return useMutation<ThreadPushed, ApiError, string>({
    mutationFn: (id) => fetchJson<ThreadPushed>(thread(name, id, 'push'), { method: 'POST' }),
  })
}

/** `…/pr`. 409 is not pushed, ahead, behind, no grant or not GitHub; 502 is GitHub. */
export function useOpenPr(name: string) {
  return useMutation<ThreadPrOpened, ApiError, string>({
    mutationFn: (id) => fetchJson<ThreadPrOpened>(thread(name, id, 'pr'), { method: 'POST', ...json({}) }),
  })
}

/** `…/merge` with the PR number the owner confirmed (Y-496): a squash, then the remote branch
 *  goes. 409 is no open PR, another PR, a head that moved during the merge or one GitHub will not merge; 502 is GitHub. */
export function useMergePr(name: string) {
  return useMutation<ThreadPrMerged, ApiError, { id: string; number: number }>({
    mutationFn: ({ id, number }) =>
      fetchJson<ThreadPrMerged>(thread(name, id, 'merge'), { method: 'POST', ...json({ number }) }),
  })
}

/** `DELETE …/threads/{id}`, `yantra chat rm`: the keeper, worktree and branch go. 409 is a running turn. */
export function useRemoveThread(name: string) {
  const client = useQueryClient()
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => fetchJson<void>(workspace(name, `/threads/${encodeURIComponent(id)}`), { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.threadStates(name) }),
  })
}

/** Y-498, `yantra chat terminal`: the thread's tmux session in its worktree,
 *  opened or attached. 404 is no thread, 409 a Mac with no tmux server, 503 a
 *  machine or a tmux that failed. */
export function useThreadTerminal(name: string) {
  return useMutation<ThreadTerminal, ApiError, string>({
    mutationFn: (id) => fetchJson<ThreadTerminal>(thread(name, id, 'terminal'), { method: 'POST' }),
  })
}

const room = (name: string, tail: string) => `/api/rooms/${encodeURIComponent(name)}/${tail}`

/** Y-536, `yantra room post`. The daemon labels it from this browser's node,
 *  sets the room's count to 0 and wakes every agent thread in it. 400 is an
 *  empty or too long text, 404 a room the daemon does not hold. */
export function usePostToRoom() {
  const client = useQueryClient()
  return useMutation<RoomPosted, ApiError, { name: string; text: string }>({
    mutationFn: ({ name, text }) =>
      fetchJson<RoomPosted>(room(name, 'messages'), { method: 'POST', ...json({ text }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.rooms() }),
  })
}

/** Y-536, `yantra room resume`: the count goes back to 0 and the pause lifts. */
export function useResumeRoom() {
  const client = useQueryClient()
  return useMutation<void, ApiError, string>({
    mutationFn: (name) => fetchJson<void>(room(name, 'resume'), { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.rooms() }),
  })
}
