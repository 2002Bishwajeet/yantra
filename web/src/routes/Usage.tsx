import { useEffect, useState } from 'react'
import type { Listed, ModelSpend, Spend, Workspace } from '@/api'
import { Stamp } from '@/components/Age'
import { DataTable } from '@/components/DataTable'
import { Section } from '@/components/Section'
import { Title } from '@/components/Title'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { loaded, useLooked } from '@/useLooked'

/** What one ask produced, and nothing before the first one. `at` is when the
 *  answer arrived here, since the route stamps no age of its own. */
type Asked =
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

function refusal(status: number | null): string {
  if (status === null) return 'The daemon did not answer.'
  return refusals[status] ?? 'The read failed.'
}

// Outside the component for `useLooked`'s reason: the React Compiler bails out
// of a function whose try/catch holds a conditional.
async function read(workspace: Workspace): Promise<Asked> {
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

/** D3 §11.4, with one correction the daemon made first: spend is per
 *  **workspace**, not per machine. `yantra tokens` loads a workspace and finds
 *  its transcript, so a per-machine figure would need either the fan-out §11.4
 *  forbids or CLI surface that does not exist.
 *
 *  Everything else §11.4 asks for holds. The page opens holding a picker and
 *  nothing else, the figure is read on request, and nothing polls it — the read
 *  opens a transcript over ssh, which is why Y-181 made it its own verb.
 *
 *  **This route is eager, and a `lazyRouteComponent` here fails a test this row
 *  may not edit**: `router.test.tsx` reads the heading outline as soon as the
 *  path changes, and a split route has not drawn its `h1` by then. So every
 *  primitive on this page is one the first paint already carries. */
export function Usage() {
  const workspaces = loaded(useLooked<Listed[]>('/api/workspaces'))
  // Above the `Section` rather than inside it: a workspaces poll that fails
  // once would otherwise take the answer you asked for off the screen with it.
  const [asked, setAsked] = useState<Asked>({ asked: 'no' })

  const ask = async (workspace: Workspace) => {
    setAsked({ asked: 'asking', workspace })
    setAsked(await read(workspace))
  }

  return (
    <>
      <Title>Usage</Title>
      <p className="text-muted-foreground max-w-prose text-sm">
        A workspace's spend is counted from the transcript on the machine that
        wrote it, over ssh. Nothing here polls: you pick a workspace and ask.
      </p>

      <Section query={workspaces} title="Which workspace">
        {(rows) => (
          <Pick
            asking={asked.asked === 'asking'}
            onAsk={(workspace) => void ask(workspace)}
            workspaces={rows}
          />
        )}
      </Section>

      <Answer asked={asked} />
    </>
  )
}

/** The same native `<select>` [`NewWorkspace.tsx`](../components/NewWorkspace.tsx)
 *  keeps, styled the same way: D3 §14 gives `ui/select` and `ui/combobox` to the
 *  row that adopts them, and this is not that row. */
const picker =
  'border-input bg-background focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]'

function Pick({
  workspaces,
  asking,
  onAsk,
}: {
  workspaces: Workspace[]
  asking: boolean
  onAsk: (workspace: Workspace) => void
}) {
  const [chosen, setChosen] = useState('')
  const one = workspaces.find((workspace) => workspace.name === chosen)

  if (workspaces.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            no workspace loaded, so there is no transcript to add up
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (one) onAsk(one)
      }}
    >
      <div className="flex w-full max-w-xs flex-col items-start gap-2">
        {/* Hand-rolled against D3 §7.4, and §9.1 is what buys it: measured on
            this route, `ui/field` costs 7.58 kB gzip on the first paint and
            `ui/label` 0.43 kB, and this route cannot be split (see the
            header). One control, one label, and no ring to lose. */}
        <label className="text-sm font-medium" htmlFor="usage-workspace">
          Workspace
        </label>
        <select
          className={picker}
          id="usage-workspace"
          name="workspace"
          onChange={(event) => setChosen(event.target.value)}
          required
          value={chosen}
        >
          <option disabled value="">
            choose a workspace
          </option>
          {workspaces.map((workspace) => (
            <option key={workspace.name} value={workspace.name}>
              {workspace.name} — {workspace.machine}
            </option>
          ))}
        </select>
      </div>
      <Button disabled={asking || !one} type="submit">
        {asking ? 'reading…' : 'Read spend'}
      </Button>
    </form>
  )
}

/** §11.4 stamps every answer with its age, and a stamp that never moves is the
 *  lie the stamp exists to prevent — nothing else on this page re-renders. A
 *  clock, not a read: it asks the daemon nothing. */
function useTick(on: boolean) {
  const [, tick] = useState(0)

  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => tick((count) => count + 1), 1_000)
    return () => clearInterval(timer)
  }, [on])
}

function Answer({ asked }: { asked: Asked }) {
  useTick(asked.asked === 'read')
  if (asked.asked === 'no') return null

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t pt-3">
        <h2 className="font-heading text-lg leading-snug font-medium">
          {asked.workspace.name}
        </h2>
        {asked.asked === 'read' && (
          <span className="text-muted-foreground text-xs">
            read <Stamp stamp={asked.at} />
          </span>
        )}
      </div>

      <div aria-live="polite">
        {/* §7: a POST that spends an ssh round trip must not look like a page
            that has finished. */}
        {asked.asked === 'asking' && (
          <div className="flex flex-col gap-2" data-slot="reading">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-64" />
            <span className="text-muted-foreground text-xs">
              reading the transcript on {asked.workspace.machine} over ssh
            </span>
          </div>
        )}

        {asked.asked === 'nothing' && (
          <Alert>
            <AlertTitle>There is nothing to add up yet.</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <span>
                No agent in this workspace has written a turn. A fresh one has
                not started, and one waiting at claude's trust prompt never gets
                that far.
              </span>
              <span className="font-mono text-xs whitespace-pre-wrap">
                {asked.said}
              </span>
            </AlertDescription>
          </Alert>
        )}

        {asked.asked === 'refused' && (
          <Alert variant="destructive">
            <AlertTitle>{refusal(asked.status)}</AlertTitle>
            {/* The daemon's whole chain: it names the machine, the command and
                what ssh said, which is the actionable half. */}
            <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
              {asked.said}
            </AlertDescription>
          </Alert>
        )}

        {asked.asked === 'read' && <Figure spend={asked.spend} />}
      </div>
    </section>
  )
}

/** `price.rs`'s own rule: under a cent is not nothing, and `$0.00` would say it
 *  was. */
function money(amount: number): string {
  return amount > 0 && amount < 0.005 ? '<$0.01' : `$${amount.toFixed(2)}`
}

// Six and seven digits unseparated cannot be compared at a glance, which is the
// only thing anyone does with them.
const count = (of: number) => of.toLocaleString()

const responses = (of: number) => `${count(of)} response${of === 1 ? '' : 's'}`

const columns = [
  { header: 'MODEL', cell: (row: ModelSpend) => <Mono>{row.model}</Mono> },
  {
    header: 'RESPONSES',
    cell: (row: ModelSpend) => <Mono>{count(row.responses)}</Mono>,
  },
  {
    header: 'COST',
    cell: (row: ModelSpend) =>
      // R-23: a model the table does not price is a question that could not be
      // answered, and `$0.00` would answer it.
      row.cost === null ? 'unpriced' : <Mono>{money(row.cost)}</Mono>,
  },
]

// D3 §5.5: Geist has no `tnum`, so a figure that shares a column is monospaced.
function Mono({ children }: { children: string }) {
  return <span className="font-mono">{children}</span>
}

function Figure({ spend }: { spend: Spend }) {
  // In fast mode every model is null for one reason, and `Money` gives it —
  // naming them here would claim the table lacks models it carries.
  const unpriced =
    spend.fast > 0 ? [] : spend.models.filter((model) => model.cost === null)

  return (
    <div className="flex flex-col gap-4">
      <Money spend={spend} />

      {/* No total across the four: they are not the same unit of anything, and
          money is the one figure that adds them. */}
      <dl className="grid w-fit grid-cols-[auto_auto] gap-x-6 gap-y-1 text-sm">
        {(
          [
            ['responses', spend.total.responses],
            ['input', spend.total.input],
            ['output', spend.total.output],
            ['cache write', spend.total.cache_write],
            ['cache read', spend.total.cache_read],
          ] as const
        ).map(([label, of]) => (
          <div className="contents" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right">
              <Mono>{count(of)}</Mono>
            </dd>
          </div>
        ))}
      </dl>

      <DataTable
        columns={columns}
        empty="no model wrote a response in this transcript"
        rowKey={(row) => row.model}
        rows={spend.models}
      />

      {unpriced.map((model) => (
        <p className="text-muted-foreground max-w-prose text-sm" key={model.model}>
          The price table does not carry <Mono>{model.model}</Mono>. Its tokens
          are in the counts above; its cost is in no figure here.
        </p>
      ))}

      {/* A path is long and a phone is 390 px wide (D3 §10), so it breaks
          rather than pushing the page sideways. */}
      <p className="text-muted-foreground text-xs break-all">
        transcript <Mono>{spend.path}</Mono>
      </p>
    </div>
  )
}

/** The three refusals to price that `render_tokens` already makes, so the
 *  browser draws neither more nor less than the terminal does. */
function Money({ spend }: { spend: Spend }) {
  const priced = spend.models.some((model) => model.cost !== null)

  if (spend.total.responses === 0) {
    return <p className="text-sm">This session has spent nothing yet.</p>
  }

  if (spend.cost === null || !priced) {
    return (
      <div className="flex flex-col gap-1">
        <p className="font-mono text-lg">unpriced</p>
        <p className="text-muted-foreground max-w-prose text-sm">
          {spend.fast > 0
            ? `${responses(spend.fast)} ran in fast mode, which is billed at a rate this price table does not carry. So this session shows tokens and no money.`
            : 'The price table carries none of the models below, so there is no figure to give.'}
        </p>
      </div>
    )
  }

  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="font-mono text-lg">{money(spend.cost)}</span>
      {/* `as_of` is the day a written-down table was read, not an instant, and
          §5.7's clock refuses a stamp that names no zone — so it prints as it
          arrived, which is what price.rs requires of the CLI too. */}
      <span className="text-muted-foreground text-xs">
        at prices of <Stamp stamp={spend.as_of} />
      </span>
    </p>
  )
}
