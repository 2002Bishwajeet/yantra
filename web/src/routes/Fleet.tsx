import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Listed, Looked, Machine, MachineSessions } from '@/api'
import {
  type AgentRow,
  agentState,
  attachable,
  chosen,
  workspaceColumns,
} from '@/columns'
import { Actions } from '@/components/Act'
import { DataTable } from '@/components/DataTable'
import { EditWorkspace } from '@/components/EditWorkspace'
import { NewWorkspace } from '@/components/NewWorkspace'
import { Section } from '@/components/Section'
import { Status } from '@/components/Status'
import { Title } from '@/components/Title'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { loaded, useAgents, useLooked } from '@/useLooked'
import { agentOf, BANDS, type Band, work, type WorkRow } from '@/work'

// §4.6: thirty idle workspaces would be the longest thing on the page and the
// least urgent. `⌘K` is how you reach a specific one.
const IDLE_SHOWN = 5

/** D3 §4.4: rows update in place every 5 s, and **the order recomputes only when
 *  you ask**. The cost, stated plainly: between the change and your tap, a row
 *  shows its true state inside the group it had when the order was last
 *  computed. A crashed agent reads *crashed — exit 1* while still under Running.
 *  That is the price of not moving a target under a thumb, and the pill is what
 *  stops it being a lie.
 *
 *  Two things are never held. A row nobody has seen before takes its live band
 *  at once — appearing is not moving, and there is no thumb over a row that was
 *  not there. And a row still in *Not read yet* is not an order to preserve:
 *  holding one there after its first read arrives would keep saying *unread*
 *  about something that has been read, which is R-23 upside down. */
function useHeldBands(rows: WorkRow[]) {
  // Not the bands, or every poll would re-seed and nothing would ever be held.
  // A row arriving, leaving, or getting its first read is all this must notice.
  const seeds = rows
    .map((row) => `${row.id} ${row.band === 'unknown' ? 'unread' : 'read'}`)
    .sort()
    .join('\n')
  const [held, setHeld] = useState(() => ({ seeds, bands: seed({}, rows) }))
  // React's own answer to adjusting state when the input changes: set it during
  // the render and let this pass be thrown away, rather than an effect that
  // paints the old order first and corrects it afterwards.
  const bands = held.seeds === seeds ? held.bands : seed(held.bands, rows)
  if (held.seeds !== seeds) setHeld({ seeds, bands })

  return {
    placed: rows.map((row) => ({ ...row, band: bands[row.id] ?? row.band })),
    changed: rows.filter((row) => bands[row.id] && bands[row.id] !== row.band)
      .length,
    reorder: () =>
      setHeld({
        seeds,
        bands: Object.fromEntries(rows.map((row) => [row.id, row.band])),
      }),
  }
}

function seed(was: Record<string, Band>, rows: WorkRow[]): Record<string, Band> {
  const now: Record<string, Band> = {}
  for (const row of rows) {
    const kept = was[row.id] ?? (row.band === 'unknown' ? null : row.band)
    if (kept) now[row.id] = kept
  }
  return now
}

export function Fleet() {
  // Four independent readings, so each group stamps its own age; one shared
  // "last updated" would be true of at most one of them.
  const machines = useLooked<Machine[]>('/api/machines')
  const listed = useLooked<Listed[]>('/api/workspaces')
  const workspaces = loaded(listed)
  const sessions = useLooked<MachineSessions[]>('/api/sessions')
  const agents = useAgents(workspaces)
  // The name, not the row: the workspace the form edits comes from the reading
  // every 30 s, so holding the row would edit against a copy of it.
  const [editing, setEditing] = useState<string | null>(null)
  const chosenToEdit =
    workspaces.looked === 'ok'
      ? workspaces.data.find((one) => one.name === editing)
      : undefined

  const { placed, changed, reorder } = useHeldBands(
    listed.looked === 'ok' ? work(listed.data, agents) : [],
  )

  return (
    <>
      <Title>Fleet</Title>

      {listed.looked !== 'ok' ? (
        <Section title="Work" query={listed}>
          {() => null}
        </Section>
      ) : (
        <>
          {changed > 0 && (
            <div>
              <Button onClick={reorder} size="sm" variant="outline">
                ↻ {changed} changed · reorder
              </Button>
            </div>
          )}
          {BANDS.map(({ band, title }) => {
            const rows = placed.filter((row) => row.band === band)
            if (rows.length === 0) return null
            return (
              <Group
                band={band}
                key={band}
                rows={rows}
                sessions={sessions}
                title={title}
              />
            )
          })}
          {placed.length === 0 && (
            <p className="text-muted-foreground text-sm">
              no workspaces yet — make one below, or at
              ~/.config/yantra/workspaces/&lt;name&gt;.toml
            </p>
          )}
        </>
      )}

      {/* Beside the create form rather than inside the row it was opened from:
          the fields are the same fields, and a phone gives them the width. */}
      {chosenToEdit && (
        <Section title={`Edit ${chosenToEdit.name}`} query={machines}>
          {(rows) => (
            <EditWorkspace
              key={chosenToEdit.name}
              workspace={chosenToEdit}
              machines={rows}
              onClose={() => setEditing(null)}
            />
          )}
        </Section>
      )}

      {/* The machines reading is the picker, so the form draws only where there
          is really something to choose from. Y-185 gives it `/new`. */}
      <Section title="New workspace" query={machines}>
        {(rows) => <NewWorkspace machines={rows} />}
      </Section>
    </>
  )
}

/** One band. §5.1: a heading, a count and a rule — never a card, because a card
 *  that holds everything communicates nothing. */
function Group({
  band,
  title,
  rows,
  sessions,
}: {
  band: Band
  title: string
  rows: WorkRow[]
  sessions: Looked<MachineSessions[]>
}) {
  const collapses = band === 'idle' && rows.length > IDLE_SHOWN
  const shown = collapses ? rows.slice(0, IDLE_SHOWN) : rows
  const rest = collapses ? rows.slice(IDLE_SHOWN) : []

  return (
    <section className="flex flex-col gap-1">
      <h2 className="flex items-baseline gap-2 border-t pt-3 font-heading text-lg leading-snug font-medium">
        {title}
        <span className="text-muted-foreground font-mono text-xs">
          {rows.length}
        </span>
      </h2>
      <ul>
        {shown.map((row) => (
          <Row key={row.id} row={row} sessions={sessions} />
        ))}
      </ul>
      {rest.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger
            render={
              <Button size="sm" variant="ghost">
                {rest.length} more
              </Button>
            }
          />
          <CollapsibleContent>
            <ul>
              {rest.map((row) => (
                <Row key={row.id} row={row} sessions={sessions} />
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  )
}

// §5.3: 3.5rem on a phone because a touch target is 44 px and a row carries a
// button; 2.5rem once there is room for one line.
const ROW = 'flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 py-1 md:min-h-10'

function Row({
  row,
  sessions,
}: {
  row: WorkRow
  sessions: Looked<MachineSessions[]>
}) {
  if (row.kind === 'machine') {
    return (
      <li className={ROW}>
        <Status
          tone="bad"
          label={`${row.machine} unreachable`}
          detail={row.error}
        />
        <span className="text-muted-foreground text-sm">
          {row.workspaces} workspace{row.workspaces === 1 ? '' : 's'}
        </span>
        <Link
          className="ml-auto text-sm"
          params={{ machine: row.machine }}
          to="/m/$machine"
        >
          Fix
        </Link>
      </li>
    )
  }

  if (row.kind === 'unusable') {
    return (
      <li className="py-1">
        {/* Y-190 gives this a Repair verb once `/w/{name}/repair` exists; until
            then the file is still the only fix (I-30). */}
        <Alert variant="destructive">
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {`${row.name} unusable: ${row.error}`}
          </AlertDescription>
        </Alert>
      </li>
    )
  }

  const { workspace, status } = row
  return (
    <li className={ROW}>
      <Link
        className="text-sm font-medium"
        params={{ name: workspace.name }}
        to="/w/$name"
      >
        {workspace.name}
      </Link>
      <span className="text-muted-foreground text-xs">
        {agentOf(workspace, status)}
      </span>
      <Link
        className="text-muted-foreground text-xs"
        params={{ machine: workspace.machine }}
        to="/m/$machine"
      >
        {workspace.machine}
      </Link>
      {/* A group heading is not a state: `finished` still says *finished*
          inside Idle, and `no_agent` says it is a shell inside Running. */}
      <Status {...agentState(status)} />
      <div className="ml-auto">
        <Actions
          chosen={chosen(workspace, status)}
          edit={null}
          terminal={attachable(workspace, sessions)}
          workspace={workspace}
        />
      </div>
    </li>
  )
}

/** A file that did not load is named below the table rather than given a row in
 *  it: `MACHINE` and `ACT` have nothing to put in one, and the edit form could
 *  not repair it anyway — `update` loads before it writes, so the file is the
 *  fix. R-23 is met by naming it loudly with its reason. */
export function Workspaces({
  entries,
  sessions,
  machines,
  agents,
  edit,
}: {
  entries: Listed[]
  sessions: Looked<MachineSessions[]>
  machines: Looked<Machine[]>
  agents: Looked<AgentRow[]>
  edit: ((name: string) => void) | null
}) {
  const rows = entries.flatMap((one) => (one.loaded === 'yes' ? [one] : []))
  const unusable = entries.flatMap((one) => (one.loaded === 'no' ? [one] : []))

  return (
    <div className="flex flex-col gap-2">
      <DataTable
        columns={workspaceColumns(sessions, machines, agents, edit)}
        rows={rows}
        rowKey={(workspace) => workspace.name}
        empty={
          unusable.length === 0
            ? 'no workspaces yet — make one below, or at ~/.config/yantra/workspaces/<name>.toml'
            : 'no file in that directory is a workspace'
        }
      />
      {unusable.map((one) => (
        <Alert key={one.name} variant="destructive">
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {`${one.name} unusable: ${one.error}`}
          </AlertDescription>
        </Alert>
      ))}
    </div>
  )
}
