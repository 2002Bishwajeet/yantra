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

/** [D2](../../docs/design/02-setup.md) §3.1's checks, one report per machine.
 *  `unknown` is a question that could not be asked and is never a shade of
 *  `absent` — the two send a reader to different places (R-23). */
export type CheckState = 'present' | 'absent' | 'unknown'

export type Check = {
  check: string
  state: CheckState
  // What was found, or why nothing could be. Carries no credential.
  detail: string
}

export type Readiness = { machine: string; checks: Check[] }

/** `POST /api/machines/{name}/readiness` re-asks the machine now and answers
 *  `Looked<Readiness>` — the same envelope the `GET` serves, at `age_seconds: 0`.
 *  A machine that does not answer is a report of `unknown` checks, not an error
 *  (R-23), and it costs a full ssh round trip. Debounce it: nothing in the
 *  daemon stops a client polling a POST ([ADR-0019](../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md)). */

/** `POST /api/workspaces/{name}/tokens`. Read on request only — it opens the
 *  agent's transcript over ssh, which is why money is on a tab somebody opens
 *  rather than on a row the fleet page refreshes. Counts and dollars only: the
 *  far machine sums them and no conversation crosses the wire (Y-181). */
export type Spend = {
  // The transcript that was read, on the machine that wrote it.
  path: string
  total: Counts
  models: ModelSpend[]
  // Responses billed at fast mode's premium. Above zero, every `cost` is null.
  fast: number
  // null is "no figure to give" — fast mode, or nothing spent yet. Never zero.
  cost: number | null
  // The day the prices were true, beside the figure they priced.
  as_of: string
}

/** No total across the four: they are not the same unit of anything. */
export type Counts = {
  // API responses, which is not the number of transcript records (I-61).
  responses: number
  input: number
  output: number
  cache_write: number
  cache_read: number
}

export type ModelSpend = {
  model: string
  responses: number
  // null is a model the price table does not carry — unpriced, never free.
  cost: number | null
}

/** `POST /api/machines/{machine}/probe` (Y-184, [ADR-0019](../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md)).
 *  Asks whether one directory is there and what origin it holds, in one round
 *  trip. Shipped with the route and unused until D4 called it. */
export type Probed = {
  machine: string
  path: string
  /** `test -d`, which is the question `up` asks — a path that is a *file*
   *  answers `false`. */
  exists: boolean
  origin: string | null
}

/** [D4](../../docs/design/04-workspace-creation.md) §3: one level of a machine's
 *  filesystem, with the repositories marked. **One level and no recursion** —
 *  a whole-home sweep measured 8.5 s on this fleet's Mac against 0.026 s on its
 *  Linux box, and D4 §2 is that measurement. */
export type Dir = {
  /** Absolute, as the far side wrote it. */
  path: string
  /** The last segment, which is what a picker draws. */
  name: string
  repo: boolean
  /** `origin`'s URL where this is a repository that has one. `null` covers both
   *  *not a repository* and *a repository with no origin*, exactly as
   *  [`probe`](../../crates/yantra-core/src/probe.rs) does. */
  origin: string | null
}

export type Listing = { machine: string; path: string; entries: Dir[] }
