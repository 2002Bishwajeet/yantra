import type { Spend, Workspace } from '@/api'

/** What one ask produced, and nothing before the first one. `at` is when the
 *  answer arrived here, since the route stamps no age of its own. */
export type Asked =
  | { asked: 'no' }
  | { asked: 'asking'; workspace: Workspace }
  | { asked: 'read'; workspace: Workspace; spend: Spend; at: string }
  // The daemon's 409: a transcript that is not there, or one with no turn in it
  // yet. Neither is a failure, so neither is drawn as one.
  | { asked: 'nothing'; workspace: Workspace; said: string }
  | {
      asked: 'refused'
      workspace: Workspace
      status: number | null
      said: string
    }

const refusals: Record<number, string> = {
  403: "This browser is not on a node this tailnet's owner holds.",
  404: 'The daemon knows no workspace by that name.',
  503: 'The machine could not be asked, so nothing was counted.',
}

export function refusal(status: number | null): string {
  if (status === null) return 'The daemon did not answer.'
  return refusals[status] ?? 'The read failed.'
}

/** `logs::locate` opens `$d/<session>.jsonl`, so the file's own name is the
 *  session Claude Code was launched with — the figure's second subject, and one
 *  no extra daemon surface has to publish. */
export function session(path: string): string {
  return (
    path
      .split('/')
      .pop()
      ?.replace(/\.jsonl$/, '') ?? path
  )
}
