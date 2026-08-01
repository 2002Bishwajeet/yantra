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
}

export type Workspace = {
  name: string
  machine: string
  repo: string
  // null is "just a shell", which is a state and not an absence.
  startup: string | null
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
