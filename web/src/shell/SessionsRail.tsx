import { Link, useRouterState } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import type { MachineSessions } from '@/api'
import { loaded, useAgents, useSessions, useWorkspaces, type Reading } from '@/api/hooks'
import type { AgentRow } from '@/columns'
import { ago } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { State } from '@/m3/mark/Mark'
import { Row, RowText } from '@/m3/row/Row'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Eyebrow, Mono } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { useTick } from '@/useTick'
import { phrase } from './phrase'

/** The tmux session behind a workspace, for its age. */
function startedAt(sessions: Reading<MachineSessions[]>, row: AgentRow): number | null {
  if (sessions.looked !== 'ok') return null
  const machine = sessions.data.find((one) => one.machine === row.workspace.machine)
  if (!machine || machine.reached !== 'yes') return null
  return machine.sessions.find((one) => one.name === row.workspace.name)?.created_at ?? null
}

function Group(props: { label: string; rows: AgentRow[]; sessions: Reading<MachineSessions[]>; open: string | null; now: number }) {
  const { label, rows, sessions, open, now } = props
  if (rows.length === 0) return null
  return (
    <section className="rail__group" aria-label={label}>
      <Eyebrow as="h3">{label}</Eyebrow>
      <ul className="rail__list">
        {rows.map((row) => {
          const { mark, words } = phrase(row.status)
          const started = startedAt(sessions, row)
          return (
            <li key={row.workspace.name}>
              <Row
                render={<Link params={{ name: row.workspace.name }} search={{ view: 'chat' }} to="/w/$name" />}
                tone={open === row.workspace.name ? 'selected' : 'lowest'}
              >
                <Tile name={row.workspace.name} />
                <RowText
                  headline={row.workspace.name}
                  supporting={
                    <State size="small" state={mark}>
                      {words} · {row.workspace.machine}
                    </State>
                  }
                />
                {started !== null ? <Mono>{ago(now / 1000 - started, now).text}</Mono> : null}
              </Row>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The desktop's left rail on `/` and `/new` (BRIEF.md, Shell): every
 *  workspace, live ones first, and a way to the fleet for the rest. */
export function SessionsRail() {
  const agents = useAgents(loaded(useWorkspaces()))
  const sessions = useSessions()
  const now = useTick(true)
  const open = useRouterState({
    select: (state) => /^\/w\/([^/]+)/.exec(state.location.pathname)?.[1] ?? null,
  })

  const live = agents.looked === 'ok' ? agents.data.filter((row) => phrase(row.status).live) : []
  const history = agents.looked === 'ok' ? agents.data.filter((row) => !phrase(row.status).live) : []

  return (
    <aside className="rail" aria-label="Sessions">
      <div className="rail__head">
        <h2 className="rail__title">Sessions</h2>
        <Button icon={<Plus />} render={<Link to="/new" />}>
          New
        </Button>
      </div>
      {agents.looked === 'pending' ? (
        <div className="rail__list" aria-busy="true">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : agents.looked === 'ok' ? (
        <>
          <Group label="Live" now={now} open={open} rows={live} sessions={sessions} />
          <Group label="History" now={now} open={open} rows={history} sessions={sessions} />
        </>
      ) : (
        <p className="rail__note">
          {agents.looked === 'never' ? 'Sessions have not been read yet.' : 'Sessions could not be read.'}
        </p>
      )}
      <Link className="rail__all" to="/fleet">
        All sessions →
      </Link>
    </aside>
  )
}
