import type { Cloning, Create, Opened, Probed, Workspace } from '@/api'
import { ApiError, asApiError } from '@/api/errors'
import type { Attached } from '@/api/socket'
import type { Plan } from './form'
import { lastLine } from './progress'
import { type Event, next, type StageId, type Stages } from './stages'

/** How often the cloned path is probed while the starting screen is open,
 *  and never faster. This is the one timed read in the dashboard: a probe of
 *  one path a person just asked for, on an interval no shorter than three
 *  seconds, and only while this screen is mounted (ADR-0019 lets nothing
 *  else poll a POST). */
export const PROBE_MS = 3_000

/** The wire, handed in so the pipeline is one pure sequence a test can run. */
export type Io = {
  clone: (body: { machine: string; url: string; path: string }) => Promise<Cloning>
  attach: (
    session: string,
    onLine: (line: string) => void,
    onEnd: (refused: ApiError | null) => void,
  ) => Attached
  probe: (path: string) => Promise<Probed>
  create: (body: Create) => Promise<Workspace>
  up: (workspace: Workspace) => Promise<Opened>
  open: (name: string) => void
  sleep: (ms: number) => Promise<void>
}

/** Runs the stages still to do, from the first, emitting as it goes. A stage
 *  that throws is emitted as refused and the run stops there; the done
 *  stages stay done, and a retry runs from the refused one. `alive` is the
 *  screen still being open: nothing is emitted after it closes. */
export async function run(
  plan: Plan,
  stages: Stages,
  io: Io,
  emit: (event: Event) => void,
  alive: () => boolean,
): Promise<void> {
  const say = (event: Event) => {
    if (alive()) emit(event)
  }
  const workspace: Workspace = {
    name: plan.name,
    machine: plan.machine,
    repo: plan.path,
    startup: plan.startup ?? null,
  }
  let at: StageId | null = next(stages)
  try {
    if (at === 'clone' && plan.clone) {
      say({ type: 'running', stage: 'clone' })
      const { session } = await io.clone({ machine: plan.machine, url: plan.clone.url, path: plan.path })
      let line = ''
      const ending: { over: boolean; refused: ApiError | null } = { over: false, refused: null }
      const socket = io.attach(
        session,
        (chunk) => {
          line = lastLine(line, chunk)
          if (line !== '') say({ type: 'progress', stage: 'clone', detail: line })
        },
        (refused) => {
          ending.over = true
          ending.refused = refused
        },
      )
      try {
        while (alive()) {
          const probed = await io.probe(plan.path)
          if (probed.exists) break
          // The session ending without the directory is `git clone` failing,
          // and its last line is what it said about why.
          if (ending.over) {
            throw (
              ending.refused ??
              new ApiError('refused', line, {
                sentence: `The clone ended and ${plan.path} is not on ${plan.machine}.`,
              })
            )
          }
          await io.sleep(PROBE_MS)
        }
      } finally {
        socket.close()
      }
      if (!alive()) return
      say({ type: 'done', stage: 'clone', detail: `cloned into ${plan.path}` })
      at = 'create'
    }
    if (at === 'create') {
      say({ type: 'running', stage: 'create' })
      await io.create({
        name: plan.name,
        machine: plan.machine,
        repo: plan.path,
        ...(plan.startup === undefined ? {} : { startup: plan.startup }),
      })
      say({ type: 'done', stage: 'create', detail: `~/.config/yantra/workspaces/${plan.name}.toml` })
      at = 'start'
    }
    if (at === 'start') {
      say({ type: 'running', stage: 'start' })
      const opened = await io.up(workspace)
      say({ type: 'done', stage: 'start', detail: opened.session === 'attached' ? 'session was already open' : 'session opened' })
      at = 'open'
    }
    if (at === 'open') {
      say({ type: 'running', stage: 'open' })
      say({ type: 'done', stage: 'open' })
      if (alive()) io.open(plan.name)
    }
  } catch (cause) {
    if (at !== null) say({ type: 'refused', stage: at, error: asApiError(cause) })
  }
}
