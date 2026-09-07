import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  Change,
  Create,
  Killed,
  Looked,
  Opened,
  Readiness,
  Removed,
  Resumed,
  Stopped,
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
 *  list what was just deleted (I-30). */
export function useCreateWorkspace() {
  const client = useQueryClient()
  return useMutation<Workspace, ApiError, Create>({
    mutationFn: (body) =>
      fetchJson<Workspace>('/api/workspaces', { method: 'POST', ...json(body) }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: keys.workspaces(), exact: true }),
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
 *  envelope at `age_seconds: 0`, so the answer goes straight into that key.
 *  A full ssh round trip: a button, never a timer (ADR-0019). */
export function useRecheckReadiness() {
  const client = useQueryClient()
  return useMutation<Looked<Readiness>, ApiError, string>({
    mutationFn: (machine) =>
      fetchJson<Looked<Readiness>>(
        `/api/machines/${encodeURIComponent(machine)}/readiness`,
        { method: 'POST' },
      ),
    onSuccess: (answer, machine) =>
      client.setQueryData(keys.readiness(machine), answer),
  })
}
