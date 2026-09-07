import { Link } from '@tanstack/react-router'
import type { MachineSessions, Session, Workspace } from '@/api'
import type { Reading } from '@/api/hooks'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { Since } from '@/screens/fleet/age'
import { KillSession } from '@/screens/fleet/Confirm'
import { Empty } from '@/screens/fleet/Empty'

type Row = { session: Session; workspace: string | null }

function rowsOf(answer: MachineSessions | undefined, workspaces: Workspace[]): Row[] {
  if (!answer || answer.reached !== 'yes') return []
  const claimed = new Set(workspaces.map((one) => one.name))
  return answer.sessions.map((session) => ({
    session,
    workspace: claimed.has(session.name) ? session.name : null,
  }))
}

/** Every tmux session on one machine, claimed or not (ADR-0022). A claimed one
 *  opens its Terminal, an unclaimed one Attaches — the same socket, named for
 *  what a reader is doing — and both may be killed. Neither is adopted. */
export function Sessions(props: {
  machine: string
  sessions: Reading<MachineSessions[]>
  workspaces: Reading<Workspace[]>
}) {
  const { machine, sessions, workspaces } = props
  const answer =
    sessions.looked === 'ok' ? sessions.data.find((one) => one.machine === machine) : undefined
  const rows = rowsOf(answer, workspaces.looked === 'ok' ? workspaces.data : [])
  const free = rows.filter((row) => row.workspace === null).length

  return (
    <Card aria-labelledby="machine-sessions" className="machine__card">
      <div className="machine__eyebrow">
        <Eyebrow as="h2" id="machine-sessions">
          Sessions
        </Eyebrow>
        {rows.length > 0 ? (
          <Text scale="body-small" tone="variant">
            {rows.length} tmux session{rows.length === 1 ? '' : 's'}
            {free > 0 ? ` · ${free} no workspace claims` : ''}
          </Text>
        ) : null}
      </div>

      {sessions.looked === 'pending' ? (
        <div aria-busy="true" className="machine__pending">
          <Skeleton shape="text" style={{ width: '58%' }} />
          <Skeleton shape="text" style={{ width: '44%' }} />
        </div>
      ) : answer?.reached === 'no' ? (
        // R-23: a machine that did not answer is data about the machine.
        <div className="machine__failed" role="status">
          <State state="failed">the machine did not answer</State>
          <Mono className="machine__detail m3-clip">{answer.error}</Mono>
        </div>
      ) : rows.length === 0 ? (
        <Empty title="No session is open here">tmux lists nothing on {machine}</Empty>
      ) : (
        <ul className="machine__rows">
          {rows.map(({ session, workspace }) => (
            <li key={session.name}>
              <div className="machine__row">
                <State
                  className="machine__state"
                  state={workspace ? 'running' : 'unknown'}
                >
                  {workspace ? 'claimed' : 'unclaimed'}
                </State>
                <span className="machine__text">
                  <span className="machine__name m3-clip">{session.name}</span>
                  <span className="machine__where m3-clip">
                    {workspace ? `workspace ${workspace}` : 'no workspace claims it'} ·{' '}
                    {session.windows} window{session.windows === 1 ? '' : 's'} ·{' '}
                    {session.attached === 0
                      ? 'detached'
                      : `${session.attached} client${session.attached === 1 ? '' : 's'}`}
                  </span>
                </span>
                <Mono className="machine__age">
                  <Since at={session.created_at} />
                </Mono>
                <span className="machine__verbs">
                  <Button
                    render={
                      <Link
                        params={{ machine, session: session.name }}
                        to="/m/$machine/s/$session"
                      />
                    }
                    role="link"
                    variant="tonal"
                  >
                    {workspace ? 'Terminal' : 'Attach'}
                  </Button>
                  <KillSession
                    machine={machine}
                    session={session.name}
                    trigger={
                      <Button tone="error" variant="text">
                        Kill
                      </Button>
                    }
                  />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Text as="p" className="machine__note" scale="body-small" tone="variant">
        Kill asks first; it cannot be undone. A session no workspace claims is not adopted: its
        repository is not on the wire, so a workspace for it starts at New session.
      </Text>
    </Card>
  )
}
