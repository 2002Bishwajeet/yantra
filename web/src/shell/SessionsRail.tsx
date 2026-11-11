import { useQueryClient } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import type { AgentRow, MachineSessions } from '@/api'
import { useHomeThreads, type HomeThreads } from '@/api/queries'
import { threadTitle } from '@/screens/session/threads'
import { fromReading } from '@/api/client'
import { loaded, useAgents, useSessions, useWorkspaces, type Reading } from '@/api/hooks'
import { ago } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
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
      <Eyebrow render={<h3 />}>{label}</Eyebrow>
      <ul className="rail__list">
        {rows.map((row) => {
          const { mark, words } = phrase(row.status)
          const started = startedAt(sessions, row)
          return (
            <li key={row.workspace.name}>
              <Row
                role="link"
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

/** ADR-0046 decision 1.3: the home chats of every machine, by title, each naming its machine. */
function Home(props: { threads: HomeThreads; open: { machine: string; thread: string | undefined } | null }) {
  const { threads, open } = props
  if (threads.state === 'unknown') return null
  return (
    <section className="rail__group" aria-label="Home">
      <Eyebrow render={<h3 />}>Home</Eyebrow>
      {threads.state === 'pending' ? (
        <div className="rail__list" aria-busy="true">
          <Skeleton shape="row" />
        </div>
      ) : threads.state === 'failed' ? (
        <ErrorSurface.Inline
          action={
            threads.error.retryable ? undefined : (
              <Button onClick={threads.retry} variant="text">
                Try again
              </Button>
            )
          }
          error={threads.error}
          reset={threads.retry}
          title="Home chats could not be read"
        />
      ) : threads.threads.length === 0 ? (
        <p className="rail__note">No home chats yet.</p>
      ) : (
        <ul className="rail__list">
          {threads.threads.map(({ machine, thread }) => (
            <li key={`${machine}/${thread.id}`}>
              <Row
                role="link"
                render={<Link params={{ machine }} search={{ thread: thread.id }} to="/m/$machine/home" />}
                tone={open?.machine === machine && open.thread === thread.id ? 'selected' : 'lowest'}
              >
                <RowText
                  headline={threadTitle(thread)}
                  supporting={
                    <State size="small" state={thread.state === 'working' ? 'running' : 'idle'}>
                      {thread.state === 'working' ? 'working' : 'idle'} · {machine}
                    </State>
                  }
                />
              </Row>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The desktop's left rail on `/` and `/new` (BRIEF.md, Shell): every
 *  workspace, live ones first, and a way to the fleet for the rest. */
export function SessionsRail() {
  const client = useQueryClient()
  const agents = useAgents(loaded(useWorkspaces()))
  const sessions = useSessions()
  const now = useTick(true)
  const homes = useHomeThreads()
  const home = useRouterState({
    select: (state) => {
      const at = /^\/m\/([^/]+)\/home$/.exec(state.location.pathname)
      if (!at) return null
      const thread = (state.location.search as { thread?: unknown }).thread
      return { machine: decodeURIComponent(at[1]), thread: typeof thread === 'string' ? thread : undefined }
    },
    structuralSharing: true,
  })
  const open = useRouterState({
    select: (state) => /^\/w\/([^/]+)/.exec(state.location.pathname)?.[1] ?? null,
  })

  const live = agents.looked === 'ok' ? agents.data.filter((row) => phrase(row.status).live) : []
  const history = agents.looked === 'ok' ? agents.data.filter((row) => !phrase(row.status).live) : []

  return (
    <aside className="rail" aria-label="Sessions">
      <div className="rail__head">
        <h2 className="rail__title">Sessions</h2>
        <Button icon={<Plus />} role="link" render={<Link to="/new" />}>
          New
        </Button>
      </div>
      {agents.looked === 'pending' ? (
        <div className="rail__list" aria-busy="true">
          <Skeleton shape="row" />
          <Skeleton shape="row" />
          <Skeleton shape="row" />
        </div>
      ) : agents.looked === 'ok' ? (
        <>
          <Group label="Live" now={now} open={open} rows={live} sessions={sessions} />
          <Group label="History" now={now} open={open} rows={history} sessions={sessions} />
        </>
      ) : agents.looked === 'failed' ? (
        <ErrorSurface.Inline
          error={fromReading(agents)!}
          reset={() => void client.invalidateQueries()}
          title="Sessions could not be read"
        />
      ) : (
        <p className="rail__note">Sessions have not been read yet.</p>
      )}
      <Home open={home} threads={homes} />
      <Link className="rail__all m3-hit" to="/fleet">
        All sessions →
      </Link>
    </aside>
  )
}
