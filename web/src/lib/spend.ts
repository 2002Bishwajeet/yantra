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

/** Here rather than beside `Answer`, because a module that exports a function
 *  next to a component loses fast refresh — and both routes need this one. */
export async function read(workspace: Workspace): Promise<Asked> {
  const path = `/api/workspaces/${encodeURIComponent(workspace.name)}/tokens`

  try {
    const response = await fetch(path, { method: 'POST' })
    if (response.status === 409) {
      return { asked: 'nothing', workspace, said: await response.text() }
    }
    if (!response.ok) {
      return {
        asked: 'refused',
        workspace,
        status: response.status,
        said: await response.text(),
      }
    }
    return {
      asked: 'read',
      workspace,
      spend: (await response.json()) as Spend,
      at: new Date().toISOString(),
    }
  } catch (cause) {
    return { asked: 'refused', workspace, status: null, said: String(cause) }
  }
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
