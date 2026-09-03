/* The page layout is rebuilt from T3 Code (MIT, (c) 2026 T3 Tools Inc.) at
   commit 963ebf5b, `apps/web/src/components/usage/UsagePage.tsx`: a headline
   of a label and one figure, a hairline strip of counts, and the model
   breakdown under both. The code is this repo's, on this repo's tokens.
   See `ui/THIRD-PARTY.md`. */
import { useEffect } from 'react'
import type { Counts, ModelSpend, Spend } from '@/api'
import { Stamp } from '@/components/Age'
import { DataTable } from '@/components/DataTable'
import { Machine } from '@/components/Machine'
import { type Asked, refusal, session } from '@/lib/spend'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useTick } from '@/useTick'

/** `/w/{name}`'s spend tab: `/usage`'s answer with the picker removed (D5
 *  §6.1). The workspace is the URL, so there is nothing to pick.
 *
 *  **Mounting it is the request.** Only the open tab is mounted (§3.5), so this
 *  component exists exactly when a person pressed `spend` — which is the press
 *  the picker's own button was. The answer is held above the tab, so coming
 *  back from the terminal spends no second ssh. */
export function SpendTab({ asked, onAsk }: { asked: Asked; onAsk: () => void }) {
  useEffect(() => {
    if (asked.asked === 'no') onAsk()
  }, [asked.asked, onAsk])

  return (
    <section className="flex flex-col gap-3">
      <div className="flex justify-end">
        {asked.asked !== 'asking' && asked.asked !== 'no' && (
          <Button onClick={onAsk} size="xs" variant="outline">
            Refresh
          </Button>
        )}
      </div>
      <Answer asked={asked} />
    </section>
  )
}

/** One workspace's answer, whatever state that ask is in. Shared with
 *  `/w/{name}`'s spend tab ([D5](../../../docs/design/05-workspace-page.md)
 *  §6.1), which passes the same `Asked` and draws no picker. */
export function Answer({ asked }: { asked: Asked }) {
  const now = useTick(asked.asked === 'read')
  if (asked.asked === 'no') return null

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t pt-3">
        <h2 className="font-heading text-lg leading-snug font-medium">
          {asked.workspace.name}
        </h2>
        {asked.asked === 'read' && (
          <span className="text-muted-foreground text-xs">
            read <Stamp now={now} stamp={asked.at} />
          </span>
        )}
      </div>

      {/* The two subjects the row asks for: a workspace, and the one session
          inside it that this figure counted. */}
      {asked.asked === 'read' && (
        <p className="text-muted-foreground text-xs">
          session <span className="font-mono">{session(asked.spend.path)}</span>{' '}
          on {asked.workspace.machine}
        </p>
      )}

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
            <AlertDescription className="flex flex-col gap-2">
              {/* D5 §7: this tab draws its own refusal and names the machine, so
                  the first one a reader opens already says where the fault is —
                  and the name stays the link to where its heartbeat is. */}
              <span>
                on <Machine name={asked.workspace.machine} />
              </span>
              {/* The daemon's whole chain: it names the machine, the command and
                  what ssh said, which is the actionable half. */}
              <span className="font-mono text-xs whitespace-pre-wrap">
                {asked.said}
              </span>
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

// The four token fields, and never `responses` — a response is not a token, and
// the strip below refuses the same total for the same reason.
const tokens = (of: Counts) =>
  of.input + of.output + of.cache_write + of.cache_read

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

// D3 §5.6, which the strip and the headline both label their figures with.
function Meta({ children }: { children: string }) {
  return (
    <span className="text-meta text-muted-foreground tracking-wider uppercase">
      {children}
    </span>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background flex flex-col gap-0.5 px-4 py-3">
      <Meta>{label}</Meta>
      <span className="text-body font-mono">{value}</span>
    </div>
  )
}

/** One session's spend, in T3's three bands: the headline, the counts, the
 *  models. It draws exactly what was asked for and computes no total across
 *  workspaces — [D6](../../../docs/design/06-sessions-attention-spend.md) §5.1
 *  refuses one, because a fleet figure costs an ssh transcript read per
 *  workspace on open. */
export function Figure({ spend }: { spend: Spend }) {
  // In fast mode every model is null for one reason, and `Money` gives it —
  // naming them here would claim the table lacks models it carries.
  const unpriced =
    spend.fast > 0 ? [] : spend.models.filter((model) => model.cost === null)

  return (
    <div className="flex flex-col gap-4">
      <Money spend={spend} />

      {/* No total across the five: they are not the same unit of anything, and
          money is the one figure that adds them. `gap-px` over the border
          colour is what draws the hairlines. */}
      <div className="bg-border grid grid-cols-2 gap-px border-y md:grid-cols-5">
        <Metric label="responses" value={count(spend.total.responses)} />
        <Metric label="input" value={count(spend.total.input)} />
        <Metric label="output" value={count(spend.total.output)} />
        <Metric label="cache write" value={count(spend.total.cache_write)} />
        <Metric label="cache read" value={count(spend.total.cache_read)} />
      </div>

      <DataTable
        columns={columns}
        empty="no model wrote a response in this transcript"
        rowKey={(row) => row.model}
        rows={spend.models}
      />

      {unpriced.map((model) => (
        <p
          className="text-muted-foreground max-w-prose text-sm"
          key={model.model}
        >
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

/** The refusals to price that `render_tokens` already makes, and one it does
 *  not: **where any model is unpriced the headline is the token count and there
 *  is no dollar line at all** (D5 §6.2).
 *
 *  The daemon still sends a `cost` there — it sums the models the table prices
 *  and names the rest as `null`, so a partly-priced session arrives with a
 *  figure that is short of what it spent. Drawing that figure under *this
 *  session* is the understatement R-23 refuses, one level up from the `$0.00`
 *  it already refuses per model. */
function Money({ spend }: { spend: Spend }) {
  const unpriced = spend.models.some((model) => model.cost === null)

  if (spend.total.responses === 0) {
    return <p className="text-sm">This session has spent nothing yet.</p>
  }

  if (spend.cost === null || unpriced) {
    return (
      <div className="flex flex-col gap-1">
        <Meta>this session</Meta>
        {/* Tokens, in the slot the money would have had. The cost, named: two
            sessions that spent very different amounts show the same headline,
            and the model named underneath is what makes it actionable. */}
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-lg">{count(tokens(spend.total))}</span>
          <span className="text-muted-foreground text-xs">
            tokens, unpriced
          </span>
        </p>
        <p className="text-muted-foreground max-w-prose text-sm">
          {spend.fast > 0
            ? `${responses(spend.fast)} ran in fast mode, which is billed at a rate this price table does not carry. So this session shows tokens and no money.`
            : 'Not every model below is priced, so there is no figure to give.'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <Meta>this session</Meta>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-lg">{money(spend.cost)}</span>
        {/* `as_of` is the day a written-down table was read, not an instant, and
            §5.7's clock refuses a stamp that names no zone — so it prints as it
            arrived, which is what price.rs requires of the CLI too. */}
        <span className="text-muted-foreground text-xs">
          at prices of <Stamp stamp={spend.as_of} />
        </span>
      </p>
    </div>
  )
}
