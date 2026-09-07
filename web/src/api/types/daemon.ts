// Y-343 serves these; written from docs/plans/m14-rust-inventory.md §2 (d, j)
// ahead of the Rust. When that row lands its DTOs in `api.ts` and
// `contract.gen.ts`, delete this file and import from there.
import type { AgentState } from '@/api'

/** `GET /api/about` — facts about the process, so a bare object and not a
 *  `Looked` envelope: nothing was asked over ssh to know them. */
export type About = {
  version: string
  target: string
  built: string
  uptime_seconds: number
  listening_on: string[]
  tailnet: string | null
}

/** `GET /api/ssh-identity`, from `identity::prepare_in`. The public half only. */
export type SshIdentity = {
  path: string
  kind: string
  public_key: string
  fingerprint: string
}

/** One entry of `GET /api/notifications`'s ring buffer (ADR-0025, proposed):
 *  what the notifier would have pushed, held in memory and gone on a restart.
 *  Read state is browser-local. The shape is a guess at what `notify.rs`
 *  already composes, and the Rust row settles it. */
export type Notification = {
  // RFC 3339, the daemon's clock.
  at: string
  workspace: string
  machine: string
  state: AgentState['state']
  // The sentence the push carried.
  said: string
}
