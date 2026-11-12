import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, RefreshCw } from 'lucide-react'
import type { MachineSessions, Session } from '@/api'
import { fromReading } from '@/api/client'
import { PrimaryAction } from '@/shell/PrimaryAction'
import {
  loaded,
  type Reading,
  useAgents,
  useAttention,
  useMachines,
  useSessions,
  useWorkspaces,
} from '@/api/hooks'
import { Button } from '@/m3/button/Button'
import { Card, type CardProps } from '@/m3/card/Card'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Mark, State } from '@/m3/mark/Mark'
import { Page } from '@/m3/page/Page'
import { PageHeader } from '@/m3/page/PageHeader'
import { Pill } from '@/m3/pill/Pill'
import { Row } from '@/m3/row/Row'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { answerFailure, reachWords } from '@/lib/checks'
import { Eyebrow, Mono, Num, Text } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { useFormFactor } from '@/shell/formFactor'
import { type Band, daemonCouldNotRead, speaks, unreachable, work, type WorkRow } from '@/work'
import { Looked, Since } from './age'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { Github } from './Github'
import { useHeldBands } from './held'
import { Stop, Verb } from './Verb'
import { detailOf, stateOf, stoppable } from './verbs'
import './Fleet.css'

// §4.6: the boards keep three idle rows and fold the rest; the phone folds
// them all behind the card's own row.
const IDLE_SHOWN = 3

type Sessions = Map<string, Session>

/** The tmux session under each workspace, by machine and name, for the row's
 *  elapsed time (Y-343's `created_at`). */
function sessionsOf(sessions: Reading<MachineSessions[]>): Sessions {
  const found: Sessions = new Map()
  if (sessions.looked !== 'ok') return found
  for (const answer of sessions.data) {
    if (answer.reached !== 'yes') continue
    for (const session of answer.sessions) found.set(`${answer.machine} ${session.name}`, session)
  }
  return found
}

export function Fleet() {
  const client = useQueryClient()
  const machines = useMachines()
  const listed = useWorkspaces()
  const workspaces = loaded(listed)
  const sessions = useSessions()
  const agents = useAgents(workspaces)
  const attention = useAttention()
  const factor = useFormFactor()

  // §7.1: the bands wait for the read that decides them, or every row would
  // land in *Not read yet* and move when the agents arrive.
  const ready = listed.looked === 'ok' && agents.looked !== 'pending'
  const { placed, changed, reorder } = useHeldBands(ready ? work(listed.data, agents) : [])
  const nothing = unreachable([machines, listed, sessions])
  const failed = [listed, agents].find((read) => read.looked === 'failed')
  const live = sessionsOf(sessions)
  const rows = (band: Band) => placed.filter((row) => row.band === band)
  const allSet = ready && placed.length > 0 && placed.every((row) => row.band === 'idle') && !speaks(attention)

  if (nothing) {
    return (
      <Page>
        <PageHeader title="Fleet" />
        <PrimaryAction action={null} />
        <ErrorSurface.Page
          error={daemonCouldNotRead(nothing)}
          eyebrow="Workspaces read"
          reset={() => void client.invalidateQueries()}
          title="The daemon could not read the fleet"
        />
      </Page>
    )
  }

  return (
    <Page>
      <PageHeader
        // §4.4: nothing moves under a thumb; the pill applies the new order.
        actions={
          <Pill disabled={changed === 0} icon={<RefreshCw />} onClick={reorder}>
            Reorder{changed > 0 ? ` · ${changed} changed` : ''}
          </Pill>
        }
        stamp={<Looked reads={[machines, listed, sessions, agents]} />}
        title="Fleet"
      />
      {/* The phone hides the h1, so the line sits in the body where it stays. */}
      <Text className="fleet__lede" render={<p />} scale="body-medium" tone="variant">
        Every workspace on every machine, and what needs you first.
      </Text>

      {failed && !ready ? (
        <ErrorSurface.Card
          error={fromReading(failed)!}
          eyebrow="Fleet"
          reset={() => void client.invalidateQueries()}
          title="The workspaces could not be read"
        />
      ) : null}
      {machines.looked === 'failed' ? (
        <ErrorSurface.Inline
          error={fromReading(machines)!}
          reset={() => void client.invalidateQueries()}
          title="Machines could not be read"
        />
      ) : null}

      {allSet ? (
        <Text className="fleet__allset" render={<p />} scale="title-small">
          All set
        </Text>
      ) : null}

      <ErrorBoundary eyebrow="Needs you" title="Needs you could not be drawn">
        <Group
          band="needs"
          count={rows('needs').length}
          empty={null}
          pending={!ready}
          rows={rows('needs')}
          sessions={live}
          surface="primary"
          title="Needs you"
        >
          {speaks(attention) ? <Github attention={attention} /> : null}
        </Group>
      </ErrorBoundary>

      <ErrorBoundary eyebrow="Running" title="Running could not be drawn">
        <Group
          band="running"
          count={rows('running').length}
          empty={null}
          pending={!ready}
          rows={rows('running')}
          sessions={live}
          surface="high"
          title="Running"
        />
      </ErrorBoundary>

      <ErrorBoundary eyebrow="Idle" title="Idle could not be drawn">
        <Idle
          empty={
            listed.looked === 'ok' && listed.data.length === 0 ? (
              <EmptyState title="No workspaces yet">
                <Link className="m3-hit" to="/new">New session</Link> makes one.
              </EmptyState>
            ) : null
          }
          limit={factor === 'phone' ? 0 : IDLE_SHOWN}
          pending={!ready}
          rows={rows('idle')}
          sessions={live}
        />
      </ErrorBoundary>

      {rows('unknown').length > 0 ? (
        <Group
          band="unknown"
          count={rows('unknown').length}
          empty={null}
          pending={false}
          rows={rows('unknown')}
          sessions={live}
          surface="container"
          title="Not read yet"
        />
      ) : null}
    </Page>
  )
}

function Pending() {
  return (
    <div aria-busy="true" className="fleet__pending">
      <Skeleton shape="row" />
      <Skeleton shape="row" style={{ width: '84%' }} />
    </div>
  )
}

/** One band as a card: the eyebrow, its count, and a row per workspace. */
function Group(props: {
  band: Band
  title: string
  count: number
  surface: CardProps['surface']
  rows: WorkRow[]
  sessions: Sessions
  pending: boolean
  empty: ReactNode
  note?: string
  children?: ReactNode
}) {
  const { band, title, count, surface, rows, sessions, pending, empty, note, children } = props
  // A band with nothing to show and nothing to do is not a card.
  if (!pending && rows.length === 0 && !empty && !children) return null
  return (
    <Card aria-labelledby={`fleet-${band}`} className="fleet__card" surface={surface}>
      <div className="fleet__eyebrow">
        <Eyebrow render={<h2 />} id={`fleet-${band}`}>
          {title}
        </Eyebrow>
        {count > 0 ? <Num>{count}</Num> : null}
        {note ? (
          <Text scale="body-small" tone="variant">
            {note}
          </Text>
        ) : null}
      </div>
      {pending ? <Pending /> : rows.length > 0 ? <Rows rows={rows} sessions={sessions} /> : empty}
      {children}
    </Card>
  )
}

/** §4.6: Idle shows a few and folds the rest, since thirty idle workspaces
 *  would be the longest thing on the page and the least urgent. */
function Idle(props: { rows: WorkRow[]; sessions: Sessions; limit: number; pending: boolean; empty: ReactNode }) {
  const { rows, sessions, limit, pending, empty } = props
  const [open, setOpen] = useState(false)
  if (!pending && rows.length === 0 && !empty) return null
  const folded = rows.length > limit
  const shown = open || !folded ? rows : rows.slice(0, limit)
  const rest = rows.length - limit
  const toggle = folded ? (
    <button aria-expanded={open} className="fleet__more m3-interactive" onClick={() => setOpen(!open)} type="button">
      {open ? 'Show fewer' : limit === 0 ? `Show ${rows.length}` : `Show ${rest} more`}
      <ChevronDown aria-hidden="true" className="fleet__chevron" />
    </button>
  ) : null

  return (
    <Card aria-labelledby="fleet-idle" className="fleet__card fleet__card--idle" data-open={open ? '' : undefined}>
      <div className="fleet__eyebrow">
        {/* The mark alone: the heading beside it is already the word (D3 §6). */}
        {limit === 0 ? <Mark size="small" state="idle" /> : null}
        <Eyebrow render={<h2 />} id="fleet-idle">
          Idle
        </Eyebrow>
        {rows.length > 0 ? <Num>{rows.length}</Num> : null}
        <Text scale="body-small" tone="variant">
          {limit === 0 ? 'nothing running' : 'nothing running, most recent first'}
        </Text>
        {limit === 0 ? <span className="fleet__spacer" /> : null}
        {limit === 0 ? toggle : null}
      </div>
      {pending ? <Pending /> : shown.length > 0 ? <Rows rows={shown} sessions={sessions} /> : rows.length === 0 ? empty : null}
      {limit > 0 ? toggle : null}
    </Card>
  )
}

function Rows(props: { rows: WorkRow[]; sessions: Sessions }) {
  const { rows, sessions } = props
  return (
    <ul className="fleet__rows">
      {rows.map((row) => (
        <li key={row.id}>
          <WorkRowView row={row} sessions={sessions} />
        </li>
      ))}
    </ul>
  )
}

/** One row of a band. A machine that did not answer is one row and its
 *  workspaces are not listed (D3 §4.1); a file that will not load names its
 *  error and links to the repair page (ADR-0020). */
export function WorkRowView(props: { row: WorkRow; sessions: Sessions }) {
  const { row, sessions } = props

  if (row.kind === 'machine') {
    const failure = answerFailure(row.error)
    const listing = failure === 'listing'
    return (
      <Row className="fleet__row">
        <State className="fleet__state" state={listing ? 'unknown' : 'failed'}>
          {listing ? 'not listed' : 'unreachable'}
        </State>
        <span className="fleet__meta">
          <Link className="fleet__name m3-hit" params={{ machine: row.machine }} to="/m/$machine">
            {row.machine}
          </Link>
          <span className="fleet__machine">
            {row.workspaces} workspace{row.workspaces === 1 ? '' : 's'}
          </span>
        </span>
        <span className="fleet__detail m3-wrap">{reachWords(failure, row.machine).cause}</span>
        <span className="fleet__actions">
          <Button render={<Link params={{ machine: row.machine }} to="/m/$machine" />} role="link" variant="outlined">
            Fix
          </Button>
        </span>
      </Row>
    )
  }

  if (row.kind === 'unusable') {
    return (
      <Row className="fleet__row">
        <State className="fleet__state" state="failed">
          will not load
        </State>
        <span className="fleet__meta">
          <span className="fleet__name">{row.name}</span>
        </span>
        <Mono className="fleet__detail m3-wrap">{row.error}</Mono>
        <span className="fleet__actions">
          <Button render={<Link params={{ name: row.name }} to="/w/$name/repair" />} role="link" variant="outlined">
            Repair
          </Button>
        </span>
      </Row>
    )
  }

  const { workspace, status } = row
  const { state, word } = stateOf(status)
  const session = sessions.get(`${workspace.machine} ${workspace.name}`)
  const detail = detailOf(status)

  return (
    <Row className="fleet__row">
      <Tile className="fleet__tile" name={workspace.name} />
      <State className="fleet__state" state={state}>
        {word}
      </State>
      <span className="fleet__meta">
        <Link className="fleet__name m3-hit" params={{ name: workspace.name }} to="/w/$name">
          {workspace.name}
        </Link>
        <Link className="fleet__machine m3-hit" params={{ machine: workspace.machine }} to="/m/$machine">
          {workspace.machine}
        </Link>
        {session ? <Since at={session.created_at} className="fleet__age" /> : null}
      </span>
      {detail ? <span className="fleet__detail m3-wrap">{detail}</span> : null}
      <span className="fleet__actions">
        <Verb status={status} workspace={workspace} />
        {row.band === 'running' && stoppable(status) ? <Stop workspace={workspace} /> : null}
      </span>
    </Row>
  )
}
