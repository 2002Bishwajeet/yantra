import { useRef, useState } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import type { Spend, Workspace } from '@/api'
import { isApiError } from '@/api/errors'
import { spendQuery } from '@/api/queries'

/** One workspace's answer. A 409 is not a failure (D5 §4.5): a transcript that
 *  is not there, or one with no turn in it yet. */
export type Row =
  | { read: 'ok'; workspace: Workspace; spend: Spend }
  | { read: 'nothing'; workspace: Workspace; said: string }
  | { read: 'refused'; workspace: Workspace; status: number | null; said: string }

export type Fanned =
  | { fanned: 'no' }
  | { fanned: 'reading'; of: number }
  | { fanned: 'done'; rows: Row[]; at: string }

// Outside the hook: the React Compiler bails out of a function whose try/catch
// holds a conditional, and this needs both (api/hooks.ts says the same).
async function readOne(client: QueryClient, workspace: Workspace): Promise<Row> {
  try {
    const spend = await client.fetchQuery(spendQuery(workspace.name))
    return { read: 'ok', workspace, spend }
  } catch (cause) {
    const status = isApiError(cause) ? (cause.status ?? null) : null
    const said = isApiError(cause) ? cause.said : String(cause)
    if (status === 409) return { read: 'nothing', workspace, said }
    return { read: 'refused', workspace, status, said }
  }
}

/** Every workspace's spend, asked for at once and only when a person asks
 *  (D5 §6.1, ADR-0019). Each read opens a transcript over ssh, so nothing here
 *  polls, refetches on focus, or runs on mount. */
export function useFleetSpend() {
  const client = useQueryClient()
  const [fanned, setFanned] = useState<Fanned>({ fanned: 'no' })
  // Two fan-outs answer in either order; only the newest one lands.
  const newest = useRef(0)

  const read = async (workspaces: Workspace[]) => {
    const mine = ++newest.current
    setFanned({ fanned: 'reading', of: workspaces.length })
    const rows = await Promise.all(workspaces.map((one) => readOne(client, one)))
    if (mine === newest.current) {
      setFanned({ fanned: 'done', rows, at: new Date().toISOString() })
    }
  }

  return { fanned, read }
}

export type ByWorkspace = {
  name: string
  machine: string
  cost: number | null
  responses: number
  models: string[]
}

const priced = (rows: Row[]) => rows.flatMap((row) => (row.read === 'ok' ? [row] : []))

/** D6 §5.1 forbids a fleet total, so these are sorted and never summed. */
export function byWorkspace(rows: Row[]): ByWorkspace[] {
  return priced(rows)
    .map(({ workspace, spend }) => ({
      name: workspace.name,
      machine: workspace.machine,
      cost: spend.cost,
      responses: spend.total.responses,
      models: spend.models.map((one) => one.model),
    }))
    .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
}

export type ByModel = {
  model: string
  responses: number
  cost: number | null
  workspaces: number
}

/** `ModelSpend.cost` is null for a model the price table does not carry —
 *  unpriced, never free — so a group holding one has no figure at all. */
export function byModel(rows: Row[]): ByModel[] {
  const found = new Map<string, { responses: number; cost: number; unpriced: boolean; where: Set<string> }>()
  for (const { workspace, spend } of priced(rows)) {
    for (const one of spend.models) {
      const held = found.get(one.model) ?? {
        responses: 0,
        cost: 0,
        unpriced: false,
        where: new Set<string>(),
      }
      held.responses += one.responses
      if (one.cost === null) held.unpriced = true
      else held.cost += one.cost
      held.where.add(workspace.name)
      found.set(one.model, held)
    }
  }
  return [...found]
    .map(([model, held]) => ({
      model,
      responses: held.responses,
      cost: held.unpriced ? null : held.cost,
      workspaces: held.where.size,
    }))
    .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
}

/** One transcript read: `logs::locate` opens `$d/<session>.jsonl`, so the
 *  file's own name is the session the agent was launched with. */
export type Line = {
  session: string
  workspace: string
  machine: string
  models: string
  input: number
  output: number
  cacheRead: number
  cost: number | null
}

const nameOf = (path: string) => path.split('/').pop()?.replace(/\.jsonl$/, '') ?? path

export function lines(rows: Row[]): Line[] {
  return rows.flatMap((row) =>
    row.read === 'ok'
      ? [
          {
            session: nameOf(row.spend.path),
            workspace: row.workspace.name,
            machine: row.workspace.machine,
            models: row.spend.models.map((one) => one.model).join(', '),
            input: row.spend.total.input,
            output: row.spend.total.output,
            cacheRead: row.spend.total.cache_read,
            cost: row.spend.cost,
          },
        ]
      : [],
  )
}
