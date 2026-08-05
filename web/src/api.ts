// Unions rather than optional properties: a `sessions?: Session[]` compiles
// and lets an unreachable machine render as "0 sessions".

export type Looked<T> =
  | { looked: 'ok'; age_seconds: number; data: T }
  | { looked: 'failed'; age_seconds: number; error: string }
  | { looked: 'never' }

export type Machine = {
  name: string
  dns_name: string
  os: 'linux' | 'macOS' | 'iOS' | 'windows' | 'android' | (string & {})
  online: boolean
  expired: boolean
  // Present as null, and meaningless when `online` — I-39.
  last_seen: string | null
  // null is "never heard from" and is not a beat that reports zero (I-47).
  heartbeat: Beat | null
}

// ADR-0013 §2: two variants, so unknown power cannot be spelled. A string and
// an object, so neither can be misread as the other.
export type Power = 'ac' | { battery: { percent: number } }

/** What a machine last said about itself, aged from when it *arrived* — the
 *  beat's own `sent_at` is diagnostic and never the freshness source. */
export type Beat = {
  age_seconds: number
  arch: string
  labels: string[]
  free_ram_mb: number
  free_disk_mb: number
  cpu_busy_pct: number
  power: Power
}

export type Workspace = {
  name: string
  machine: string
  repo: string
  // null is "just a shell", which is a state and not an absence.
  startup: string | null
}

/** One entry of `GET /api/workspaces`. Y-054's rule applied to a file rather
 *  than a machine: one that did not load stays in the list under its name
 *  carrying why, and the workspaces beside it are still answered.
 *
 *  A failed entry is named *below* the table rather than drawn as a row in it —
 *  it has no machine to show a state for, nothing for `ACT` or `TERMINAL` to
 *  target, and `EDIT` cannot repair it, since `update` loads before it writes
 *  and the file is the fix. */
export type Listed =
  | ({ loaded: 'yes' } & Workspace)
  | { loaded: 'no'; name: string; error: string }

/** `POST /api/workspaces/{name}/up`. `attached` beside `launched: false` is the
 *  idempotent success §B4 requires, and never a failure to report (I-30). */
export type Opened = {
  machine: string
  session: 'created' | 'attached'
  launched: boolean
  term: string
}

/** `POST /api/workspaces/{name}/down`. `stopped: false` is "there was nothing
 *  running", and `ending` is null for a session that held no agent (Y-099). */
export type Stopped = {
  machine: string
  stopped: boolean
  ending: string | null
}

/** `POST /api/workspaces/{name}/resume`. `resumed: false` is an agent already
 *  working in that session, which ADR-0015 leaves exactly as it is. */
export type Resumed = {
  machine: string
  resumed: boolean
  term: string
}

/** The text frame a browser sends on `GET /api/workspaces/{name}/terminal`,
 *  first and on every resize. Binary frames either way are terminal bytes, and
 *  a text frame coming back is why the terminal could not be opened. */
export type TerminalSize = {
  rows: number
  cols: number
  term: string
}

export type Session = {
  name: string
  windows: number
  // A client count, so 0 means detached.
  attached: number
  // tmux's own formatting on the remote machine's clock. Opaque.
  created: string
}

export type MachineSessions =
  | { machine: string; reached: 'yes'; sessions: Session[] }
  | { machine: string; reached: 'no'; error: string }

// A sibling of `status` rather than part of `running`, and it outlives it: a
// pane can die under a process claude's registry still lists.
export type AgentSession = {
  id: string
  pid: number
}

/** Every `Verdict` by name: `no_agent` is a plain shell and ordinary (Y-091),
 *  `unclear` beside it is R-2's contradiction, `awaiting_trust` is I-49. */
export type AgentState =
  | { state: 'no_session' }
  | { state: 'running' }
  | { state: 'finished' }
  | { state: 'stopped' }
  | { state: 'crashed'; exit_status: number }
  | { state: 'killed'; signal: string }
  | { state: 'no_agent' }
  | { state: 'awaiting_trust' }
  | { state: 'unclear'; because: string }

export type WorkspaceStatus = { workspace: string; machine: string } & (
  | { reached: 'yes'; status: AgentState; session: AgentSession | null }
  | { reached: 'no'; error: string }
)
