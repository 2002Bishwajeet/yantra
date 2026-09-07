import { useState, type ReactNode } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleDot, GitPullRequest, Plus, RotateCw } from 'lucide-react'
import type { Attention, Event, Item, Machine, MachineSessions, Workspace } from '@/api'
import { fromReading } from '@/api/client'
import { ApiError, asApiError } from '@/api/errors'
import {
  loaded,
  useAgents,
  useAttention,
  useMachines,
  useNotifications,
  useSessions,
  useWorkspaces,
  type Reading,
} from '@/api/hooks'
import { MISSING, statusQuery, workspacesQuery } from '@/api/queries'
import type { AgentRow } from '@/columns'
import { ago, at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Disclosure } from '@/m3/disclosure/Disclosure'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State } from '@/m3/mark/Mark'
import { Pill } from '@/m3/pill/Pill'
import { Row, RowText } from '@/m3/row/Row'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { IconTile, Tile } from '@/m3/tile/Tile'
import { Track } from '@/m3/track/Track'
import { KillSession } from '@/screens/fleet/Confirm'
import { useFormFactor } from '@/shell/formFactor'
import { asEvents } from '@/shell/notifications'
import { phrase } from '@/shell/phrase'
import { usePrefs } from '@/shell/prefs'
import { useTick } from '@/useTick'
import { unclaimed, unreachable, work, type WorkRow } from '@/work'
import { elapsed } from '@/screens/fleet/clock'
import { askedAt, online, recent, stamp, startedAt } from './bands'
import { useHeldBands } from '@/screens/fleet/held'
import './Dashboard.css'

const UNREACHABLE =
  'Every read failed the same way, so this is the connection to yantrad rather than the fleet. ' +
  'Whether you are off the tailnet or the daemon is down is not something this page can tell.'

/** Try again, from any surface here: every read is asked again, and so is a
 *  status read the workspace list unlocks — the person tapped once, and the
 *  second wave of reads is theirs too. */
async function readAgain(client: QueryClient) {
  await client.invalidateQueries()
  const listed = client.getQueryData(workspacesQuery().queryKey)
  if (listed?.looked !== 'ok') return
  const names = listed.data.map((one) => one.name)
  await Promise.all(names.map((name) => client.fetchQuery(statusQuery(name))))
  const failed = names.filter((name) => {
    const answer = client.getQueryData(statusQuery(name).queryKey)
    return answer !== undefined && answer !== MISSING && answer.looked === 'failed'
  })
  await Promise.all(failed.map((name) => client.refetchQueries({ queryKey: statusQuery(name).queryKey })))
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A fleet with no workspaces has no status reads to make, and `useAgents`
 *  calls no reads `never`. The EmptyDashboard board draws its bands empty
 *  rather than *not looked at yet*, so the empty list is a reading of its own. */
const NO_AGENTS: Reading<AgentRow[]> = { looked: 'ok', age_seconds: 0, data: [] }

function Stamp(props: { reads: Parameters<typeof stamp>[0]; now: number; className?: string }) {
  const { reads, now, className } = props
  const read = stamp(reads)
  if (!read) return null
  return (
    <Mono className={className ?? 'dash__stamp'}>
      as of {ago(read.age, now).text}
      {read.late.map((one) => ` · ${one.name} ${ago(one.age, now).text}`)}
    </Mono>
  )
}

function CardHead(props: { id: string; title: string; words: ReactNode }) {
  return (
    <div className="dash__head">
      <Text as="h2" emphasized id={props.id} scale="title-large">
        {props.title}
      </Text>
      <Text scale="body-medium" tone="variant">
        {props.words}
      </Text>
    </div>
  )
}

function NotLooked(props: { what: string }) {
  return (
    <Text scale="body-medium" tone="variant">
      {props.what} not been looked at yet.
    </Text>
  )
}

/** "5 of 6 machines online · thinkpad unreachable 2h · Fix →" */
function Strip(props: {
  machines: Reading<Machine[]>
  notAnswering: string[]
  now: number
  retry: () => void
  stamp: ReactNode
}) {
  const { machines, notAnswering, now, retry, stamp: aged } = props
  if (machines.looked === 'pending') {
    return (
      <div className="dash__strip" data-slot="reading">
        <Skeleton shape="text" style={{ width: 240 }} />
      </div>
    )
  }
  if (machines.looked === 'failed') {
    return (
      <ErrorSurface.Inline error={fromReading(machines)!} reset={retry} title="Machines could not be read" />
    )
  }
  if (machines.looked === 'never') {
    return (
      <div className="dash__strip">
        <NotLooked what="Machines have" />
        {aged}
      </div>
    )
  }
  const { up, down } = online(machines.data, now)
  // A machine the tailnet sees and ssh did not reach is down for this page too.
  const named = new Set(down.map((one) => one.name))
  const all = [...down, ...notAnswering.filter((name) => !named.has(name)).map((name) => ({ name, since: null }))]
  return (
    <div className="dash__strip">
      <div className="dash__facts">
        <State state="running">
          {up} of {machines.data.length}
          <span className="dash__long"> machines</span> online
        </State>
        {all.map((one) => (
          <span className="dash__fact" key={one.name}>
            <span aria-hidden="true" className="dash__dot">
              ·
            </span>
            <State className="dash__down" state="unknown">
              {one.name} unreachable{one.since ? <span className="dash__long"> {one.since}</span> : null}
            </State>
            <span aria-hidden="true" className="dash__dot">
              ·
            </span>
            <Link className="dash__fix" params={{ machine: one.name }} to="/m/$machine">
              Fix<span className="dash__long"> →</span>
            </Link>
          </span>
        ))}
      </div>
      {aged}
    </div>
  )
}

function GithubRow(props: { item: Item; kind: 'review' | 'issue'; now: number }) {
  const { item, kind, now } = props
  const short = item.repo.split('/')[1] ?? item.repo
  const age = at(item.updated_at, now)
  return (
    <Row tone="translucent">
      <IconTile>{kind === 'review' ? <GitPullRequest /> : <CircleDot />}</IconTile>
      <RowText
        headline={`${kind === 'review' ? 'Review requested' : 'Issue assigned'}: ${short}#${item.number}`}
        supporting={
          <>
            {item.title}
            {age ? <> · <Mono>{age.text}</Mono></> : null}
          </>
        }
      />
      <Button render={<a href={item.url} rel="noreferrer" target="_blank" />} role="link">
        {kind === 'review' ? 'Review' : 'Open'}
      </Button>
    </Row>
  )
}

function NeedsRow(props: { row: WorkRow; events: Event[]; now: number }) {
  const { row, events, now } = props
  if (row.kind === 'machine') return null
  if (row.kind === 'unusable') {
    return (
      <Row tone="translucent">
        <Tile name={row.name} />
        <RowText
          headline={`${row.name} will not load`}
          supporting={
            <State size="small" state="failed">
              <Mono>{row.error}</Mono>
            </State>
          }
        />
        <Button render={<Link params={{ name: row.name }} to="/w/$name/repair" />} role="link" variant="text">
          Repair
        </Button>
      </Row>
    )
  }
  const { workspace, status } = row
  const { mark, words } = phrase(status)
  const state = status?.reached === 'yes' ? status.status : null
  if (state?.state === 'awaiting_trust') {
    const asked = askedAt(events, workspace.name)
    return (
      <Row tone="translucent">
        <Tile name={workspace.name} />
        <RowText
          headline={`${workspace.name} is waiting for trust`}
          supporting={
            <State size="small" state="needs">
              waiting · {workspace.machine}
              {asked ? (
                <>
                  {' '}
                  · asked <Mono>{ago(now / 1000 - asked.at, now).text}</Mono> ago · {asked.said}
                </>
              ) : null}
            </State>
          }
        />
        <Button
          render={<Link params={{ name: workspace.name }} search={{ view: 'chat' }} to="/w/$name" />}
          role="link"
        >
          Answer
        </Button>
      </Row>
    )
  }
  return (
    <Row tone="translucent">
      <Tile name={workspace.name} />
      <RowText
        headline={
          state?.state === 'unclear'
            ? `${workspace.name} is unclear`
            : `${workspace.name} ${state?.state === 'killed' ? 'was killed' : 'crashed'}`
        }
        supporting={
          <State size="small" state={mark}>
            {state?.state === 'unclear' ? state.because : `${words} · ${workspace.machine}`}
          </State>
        }
      />
      {state?.state === 'unclear' ? null : (
        <Button
          render={<Link params={{ name: workspace.name }} search={{ view: 'chat' }} to="/w/$name" />}
          role="link"
          variant="text"
        >
          Open
        </Button>
      )}
    </Row>
  )
}

/** The one primary-container card on the page: D3 §4's first band, with
 *  D6 §3's GitHub queue under the workspace rows. */
function Hero(props: {
  rows: WorkRow[]
  attention: Reading<Attention>
  events: Event[]
  now: number
  retry: () => void
  stamp: ReactNode
}) {
  const { rows, attention, events, now, retry, stamp: aged } = props
  const items = attention.looked === 'ok' ? attention.data.reviews.length + attention.data.issues.length : 0
  const count = rows.length + items
  const empty = count === 0 && attention.looked === 'ok'
  return (
    <Card aria-labelledby="dash-needs" className="dash__hero" surface="primary">
      <div className="dash__hero-head">
        <Eyebrow as="h2" className="dash__hero-eyebrow" id="dash-needs">
          Needs you
        </Eyebrow>
        {empty ? null : (
          <>
            <span className="dash__hero-n">{count}</span>
            <Text className="dash__hero-words" scale="title-medium">
              {count === 1 ? 'thing is' : 'things are'} waiting on you
            </Text>
          </>
        )}
        {aged}
      </div>
      {empty ? (
        <>
          <div className="dash__hero-empty">
            <State className="dash__hero-empty-title" state="idle">
              Nothing needs you
            </State>
            <Text scale="body-large">
              when an agent asks for trust or a review is requested, it appears here first
            </Text>
          </div>
          <div>
            <Button icon={<Plus />} render={<Link to="/new" />} role="link">
              New session
            </Button>
          </div>
        </>
      ) : (
        <div className="dash__rows">
          {rows.map((row) => (
            <NeedsRow events={events} key={row.id} now={now} row={row} />
          ))}
          {attention.looked === 'ok' ? (
            <>
              {attention.data.reviews.map((item) => (
                <GithubRow item={item} key={item.url} kind="review" now={now} />
              ))}
              {attention.data.issues.map((item) => (
                <GithubRow item={item} key={item.url} kind="issue" now={now} />
              ))}
              {attention.data.notifications > 0 ? (
                <a className="dash__unread" href="https://github.com/notifications" rel="noreferrer" target="_blank">
                  {plural(attention.data.notifications, 'unread notification')} on GitHub →
                </a>
              ) : null}
            </>
          ) : attention.looked === 'failed' ? (
            <ErrorSurface.Inline error={fromReading(attention)!} reset={retry} title="GitHub could not be read" />
          ) : attention.looked === 'never' ? (
            <NotLooked what="GitHub has" />
          ) : (
            <Skeleton />
          )}
        </div>
      )}
    </Card>
  )
}

function RunningRow(props: {
  row: Extract<WorkRow, { kind: 'workspace' }>
  started: number | null
  longest: number
  now: number
  phone: boolean
}) {
  const { row, started, longest, now, phone } = props
  const { mark, words } = phrase(row.status)
  const seconds = started === null ? null : now / 1000 - started
  const link = <Link params={{ name: row.workspace.name }} search={{ view: 'chat' }} to="/w/$name" />
  return (
    <Row className="dash__run" render={phone ? link : undefined} tone="lowest">
      <div className="dash__run-line">
        <Tile name={row.workspace.name} />
        <RowText
          headline={row.workspace.name}
          supporting={
            <State size="small" state={mark}>
              {words} · {row.workspace.machine}
            </State>
          }
        />
        <Mono className="dash__elapsed">{seconds === null ? '' : elapsed(seconds)}</Mono>
      </div>
      {seconds === null ? null : (
        <Track
          className="dash__track"
          label={`elapsed, ${elapsed(seconds)} of the longest ${elapsed(longest)}`}
          value={longest > 0 ? seconds / longest : 0}
        />
      )}
      {phone ? null : (
        <Button className="dash__open" render={link} role="link" variant="text">
          Open
        </Button>
      )}
    </Row>
  )
}

function Running(props: { rows: WorkRow[]; sessions: Reading<MachineSessions[]>; now: number; phone: boolean }) {
  const { rows, sessions, now, phone } = props
  const live = rows.flatMap((row) => (row.kind === 'workspace' ? [row] : []))
  const timed = live.map((row) => ({ row, started: startedAt(sessions, row.workspace) }))
  const longest = Math.max(0, ...timed.flatMap((one) => (one.started === null ? [] : [now / 1000 - one.started])))
  return (
    <Card aria-labelledby="dash-running" className="dash__running" surface="high">
      <CardHead
        id="dash-running"
        title="Running"
        words={
          <>
            {plural(live.length, 'session')}
            {longest > 0 ? (
              <>
                {' '}
                · longest <Mono>{elapsed(longest)}</Mono>
              </>
            ) : null}
          </>
        }
      />
      {live.length === 0 ? (
        <div className="dash__empty">
          <State className="dash__empty-title" state="idle">
            Nothing is running
          </State>
          <Text scale="body-medium" tone="variant">
            Start a session and its elapsed time shows here
          </Text>
        </div>
      ) : (
        <div className="dash__rows">
          {timed.map(({ row, started }) => (
            <RunningRow key={row.id} longest={longest} now={now} phone={phone} row={row} started={started} />
          ))}
        </div>
      )}
    </Card>
  )
}

/** D6 §4.3: Attach and Kill for a session no workspace claims, never Adopt. */
function Worth(props: {
  sessions: Reading<MachineSessions[]>
  workspaces: Reading<Workspace[]>
  now: number
  retry: () => void
}) {
  const { sessions, workspaces, now, retry } = props
  if (sessions.looked === 'pending') {
    return <Skeleton style={{ height: 64 }} />
  }
  if (sessions.looked === 'failed') {
    return (
      <ErrorSurface.Card
        error={fromReading(sessions)!}
        eyebrow="Worth a look"
        reset={retry}
        title="Sessions could not be read"
      />
    )
  }
  const rows = sessions.looked === 'ok' ? unclaimed(sessions.data, workspaces) : []
  const unknown = sessions.looked === 'never' || workspaces.looked !== 'ok'
  return (
    <Card aria-labelledby="dash-worth" className="dash__worth" surface="tertiary">
      <div className="dash__worth-head">
        <Eyebrow as="h2" id="dash-worth">
          Worth a look
        </Eyebrow>
        <Text scale="body-medium">
          {unknown ? 'unclaimed sessions unknown' : `${plural(rows.length, 'session')} no workspace claims`}
        </Text>
      </div>
      {sessions.looked === 'never' ? (
        <NotLooked what="Sessions have" />
      ) : unknown ? (
        <State state="unknown">no workspace list to check these against, so none can be called unclaimed</State>
      ) : rows.length === 0 ? (
        <State state="idle">every tmux session on the machines that answered belongs to a workspace</State>
      ) : (
        <ul className="dash__unclaimed-list">
          {rows.map(({ machine, session }) => (
            <li className="dash__unclaimed" key={`${machine} ${session.name}`}>
              <State state="unknown">
                <span className="dash__name">{session.name}</span>
                <span className="dash__meta">
                  {machine} · {plural(session.windows, 'window')} ·{' '}
                  <Mono>{ago(now / 1000 - session.created_at, now).text}</Mono>
                </span>
              </State>
              <Button
                className="dash__attach"
                render={<Link params={{ machine, session: session.name }} to="/m/$machine/s/$session" />}
                role="link"
                variant="text"
              >
                Attach
              </Button>
              <KillSession
                machine={machine}
                row={
                  <Row>
                    <RowText
                      headline={session.name}
                      supporting={`${machine} · ${plural(session.windows, 'window')} · ${ago(now / 1000 - session.created_at, now).text}`}
                    />
                  </Row>
                }
                session={session.name}
                trigger={
                  <Button className="dash__kill" tone="error" variant="text">
                    Kill
                  </Button>
                }
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function IdleRow(props: { row: Extract<WorkRow, { kind: 'workspace' }>; sessions: Reading<MachineSessions[]>; now: number }) {
  const { row, sessions, now } = props
  const { mark, words } = phrase(row.status)
  const started = startedAt(sessions, row.workspace)
  return (
    <li>
      <Row
        className="dash__idle-row"
        render={<Link params={{ name: row.workspace.name }} search={{ view: 'chat' }} to="/w/$name" />}
        tone="lowest"
      >
        <Tile name={row.workspace.name} size="small" />
        <span className="dash__name m3-clip">{row.workspace.name}</span>
        <State size="small" state={mark}>
          {words}
        </State>
        {started === null ? null : <Mono className="dash__age">{ago(now / 1000 - started, now).text}</Mono>}
      </Row>
    </li>
  )
}

const names = (rows: WorkRow[]) => {
  const all = rows.flatMap((row) => (row.kind === 'workspace' ? [row.workspace.name] : []))
  const shown = all.slice(0, 3)
  const rest = all.length - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : (shown[0] ?? '')
}

/** D3 §4.6: Idle collapses. Compact opens it as a grid instead (BRIEF.md). */
function Idle(props: {
  rows: WorkRow[]
  sessions: Reading<MachineSessions[]>
  now: number
  compact: boolean
  fleetEmpty: boolean
}) {
  const { rows, sessions, now, compact, fleetEmpty } = props
  const workspaces = rows.flatMap((row) => (row.kind === 'workspace' ? [row] : []))
  const words = `${plural(workspaces.length, 'workspace')}, nothing running`
  const none = fleetEmpty ? 'no workspaces yet' : 'no idle workspaces'
  const list = (
    <ul className={compact ? 'dash__grid' : 'dash__idle-list'}>
      {workspaces.map((row) => (
        <IdleRow key={row.id} now={now} row={row} sessions={sessions} />
      ))}
    </ul>
  )
  if (compact) {
    return (
      <Card aria-labelledby="dash-idle" className="dash__idle" variant="outlined">
        <CardHead id="dash-idle" title="Idle" words={<State state="idle">{words}</State>} />
        {workspaces.length === 0 ? <State state="idle">{none}</State> : list}
      </Card>
    )
  }
  if (workspaces.length === 0) {
    // The empty board's Idle line: the fleet is the only thing missing, so
    // New is the one verb on it.
    return (
      <div className="dash__line">
        <Eyebrow as="h2">Idle</Eyebrow>
        <State state="idle">{none}</State>
        {fleetEmpty ? (
          <Button className="dash__new" render={<Link to="/new" />} role="link" variant="text">
            New →
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <Disclosure
      action="Show"
      summary={
        <>
          <Eyebrow as="h2">Idle</Eyebrow>
          <State state="idle">
            {words}
            <span className="dash__names"> · {names(rows)}</span>
          </State>
        </>
      }
    >
      {list}
    </Disclosure>
  )
}

/** Compact only: the last five session events, from the ring buffer. */
function Recent(props: { events: Event[]; error: ApiError | null; now: number; retry: () => void }) {
  const { events, error, now, retry } = props
  if (error) {
    return <ErrorSurface.Card error={error} eyebrow="Recent" reset={retry} title="Events could not be read" />
  }
  const rows = recent(events)
  return (
    <Card aria-labelledby="dash-recent" className="dash__recent">
      <CardHead
        id="dash-recent"
        title="Recent"
        words={`last ${rows.length} session event${rows.length === 1 ? '' : 's'}`}
      />
      {rows.length === 0 ? (
        <Text scale="body-medium" tone="variant">
          Nothing has happened since the daemon started.
        </Text>
      ) : (
        <ul className="dash__idle-list">
          {rows.map((one) => (
            <li key={`${one.workspace} ${one.at}`}>
              <Row
                className="dash__recent-row"
                render={<Link params={{ name: one.workspace }} search={{ view: 'chat' }} to="/w/$name" />}
                tone="lowest"
              >
                <Tile name={one.workspace} size="small" />
                <span className="dash__name m3-clip">{one.workspace}</span>
                <State className="dash__recent-words" size="small" state={one.mark}>
                  {one.words} · {one.machine}
                </State>
                <Mono className="dash__age">{ago(now / 1000 - one.at, now).text}</Mono>
              </Row>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Pending() {
  return (
    <div aria-busy="true" className="dash" data-slot="reading">
      <Skeleton shape="text" style={{ width: 320 }} />
      <Skeleton style={{ height: 220 }} />
      <Skeleton style={{ height: 280 }} />
      <Skeleton style={{ height: 64 }} />
      <Skeleton style={{ height: 52 }} />
    </div>
  )
}

export function Dashboard() {
  // Four readings, each stamping its own age; the strip carries the oldest.
  const machines = useMachines()
  const listed = useWorkspaces()
  const workspaces = loaded(listed)
  const sessions = useSessions()
  const fleetEmpty = listed.looked === 'ok' && listed.data.length === 0
  const read = useAgents(workspaces)
  const agents = fleetEmpty ? NO_AGENTS : read
  // The fifth is on the daemon's 300 s clock and stamps itself (D6 §2).
  const attention = useAttention()
  const notifications = useNotifications()
  const events = asEvents(notifications.data)
  const client = useQueryClient()
  const now = useTick(true)
  const factor = useFormFactor()
  const { density } = usePrefs()
  const retry = () => void readAgain(client)

  // §7.1: the bands wait for the read that decides them. Drawing rows before
  // it lands would file every one under *Not read yet* and move them all when
  // it arrives — the reordering §4.4 exists to prevent.
  const reading = listed.looked === 'pending' || agents.looked === 'pending' ? 'pending' : listed.looked
  const { placed, changed, reorder } = useHeldBands(
    listed.looked === 'ok' && agents.looked === 'ok' ? work(listed.data, agents) : [],
  )
  const nothing = unreachable([machines, listed, sessions])

  // The last time the page could be read, for the Unreachable surface's stamp:
  // noted during the render, once per reading, as `useHeldBands` notes its seeds.
  const [good, setGood] = useState<{ reading: unknown; at: number } | null>(null)
  if (nothing === null && machines.looked === 'ok' && good?.reading !== machines) {
    setGood({ reading: machines, at: now })
  }

  const title = (
    <Text as="h1" className="dash__title" emphasized scale="headline-medium">
      Dashboard
    </Text>
  )

  if (nothing) {
    return (
      <>
        {title}
        <ErrorSurface.Page
          action={
            <Button render={<a href="https://login.tailscale.com/admin/machines" rel="noreferrer" target="_blank" />} role="link" variant="text">
              Open Tailscale
            </Button>
          }
          autoFocus
          error={new ApiError('network', nothing, { sentence: UNREACHABLE })}
          eyebrow="Dashboard"
          meta={good === null ? undefined : `last good read ${ago((now - good.at) / 1000, now).text} ago`}
          reset={retry}
          title="Nothing here can be reached"
          unknowns={['off the tailnet', 'yantrad down']}
        />
      </>
    )
  }

  if (reading === 'pending') {
    return (
      <>
        {title}
        <Pending />
      </>
    )
  }

  const reads = [
    { name: 'machines', reading: machines },
    { name: 'workspaces', reading: listed },
    { name: 'sessions', reading: sessions },
    { name: 'agents', reading: agents },
  ]
  const phone = factor === 'phone'
  const compact = density === 'compact'
  const stripStamp = phone ? null : <Stamp now={now} reads={reads} />
  const heroStamp = phone ? <Stamp className="dash__hero-stamp" now={now} reads={reads} /> : null
  const band = (which: WorkRow['band']) => placed.filter((row) => row.band === which)
  const notAnswering = placed.flatMap((row) => (row.kind === 'machine' ? [row.machine] : []))
  const unread = band('unknown')

  return (
    <div className="dash">
      {title}
      <ErrorBoundary layout="inline" title="The status line could not be drawn">
        <Strip machines={machines} notAnswering={notAnswering} now={now} retry={retry} stamp={stripStamp} />
      </ErrorBoundary>
      {changed > 0 ? (
        <div>
          <Pill icon={<RotateCw />} onClick={reorder}>
            {changed} changed · reorder
          </Pill>
        </div>
      ) : null}
      {listed.looked === 'failed' || agents.looked === 'failed' ? (
        <ErrorSurface.Card
          error={fromReading(listed.looked === 'failed' ? listed : agents)!}
          eyebrow="Needs you · Running · Idle"
          reset={retry}
          title="Workspaces could not be read"
        />
      ) : listed.looked === 'never' || agents.looked === 'never' ? (
        <Card>
          <NotLooked what="Workspaces have" />
        </Card>
      ) : (
        <>
          <ErrorBoundary eyebrow="Needs you" title="Needs you could not be drawn">
            <Hero
              attention={attention}
              events={events}
              now={now}
              retry={retry}
              rows={band('needs').filter((row) => row.kind !== 'machine')}
              stamp={heroStamp}
            />
          </ErrorBoundary>
          <ErrorBoundary eyebrow="Running" title="Running could not be drawn">
            <Running now={now} phone={phone} rows={band('running')} sessions={sessions} />
          </ErrorBoundary>
        </>
      )}
      <ErrorBoundary eyebrow="Worth a look" title="Worth a look could not be drawn">
        <Worth now={now} retry={retry} sessions={sessions} workspaces={workspaces} />
      </ErrorBoundary>
      {listed.looked === 'ok' && agents.looked === 'ok' ? (
        compact ? (
          <div className="dash__pair">
            <ErrorBoundary eyebrow="Idle" title="Idle could not be drawn">
              <Idle compact fleetEmpty={fleetEmpty} now={now} rows={band('idle')} sessions={sessions} />
            </ErrorBoundary>
            <ErrorBoundary eyebrow="Recent" title="Recent could not be drawn">
              <Recent error={notifications.error ? asApiError(notifications.error) : null} events={events} now={now} retry={retry} />
            </ErrorBoundary>
          </div>
        ) : (
          <ErrorBoundary eyebrow="Idle" title="Idle could not be drawn">
            <Idle compact={false} fleetEmpty={fleetEmpty} now={now} rows={band('idle')} sessions={sessions} />
          </ErrorBoundary>
        )
      ) : null}
      {unread.length > 0 ? (
        <div className="dash__line">
          <Eyebrow as="h2">Not read yet</Eyebrow>
          <State state="unknown">{names(unread)}</State>
        </div>
      ) : null}
    </div>
  )
}
