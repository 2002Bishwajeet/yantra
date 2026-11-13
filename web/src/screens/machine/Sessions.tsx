import { Link } from '@tanstack/react-router'
import type { MachineSessions, Session, Workspace } from '@/api'
import type { Reading } from '@/api/hooks'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Text } from '@/m3/text/Text'
import { Since } from '@/screens/fleet/age'
import { KillSession } from '@/screens/fleet/Confirm'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { fromReading } from '@/api/client'
import { reachWords } from '@/lib/checks'
import { SshSaid } from './ReachFailure'
import { sessionsFailure, type Verdict } from './verdict'

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
  verdict: Verdict
}) {
  const { machine, sessions, workspaces, verdict } = props
  const answer =
    sessions.looked === 'ok' ? sessions.data.find((one) => one.machine === machine) : undefined
  const rows = rowsOf(answer, workspaces.looked === 'ok' ? workspaces.data : [])
  const free = rows.filter((row) => row.workspace === null).length
  const failure = answer?.reached === 'no' ? sessionsFailure(verdict, answer.error) : null

  // A card with no session and nothing to report has nothing to say.
  if (rows.length === 0 && !failure && sessions.looked !== 'pending' && sessions.looked !== 'failed') return null

  return (
    <Card aria-labelledby="machine-sessions" className="machine__card" surface="container">
      <div className="machine__head">
        <Text render={<h2 />} emphasized id="machine-sessions" scale="title-large">
          Sessions
        </Text>
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
      ) : failure?.kind === 'listing' ? (
        // Y-585: ssh got in or never ran, so this is not Readiness's failure.
        <div className="machine__failed" role="status">
          <State state="unknown">The sessions could not be listed</State>
          <Text render={<p />} scale="body-small" tone="variant">
            {reachWords('listing', machine).next}
          </Text>
          <SshSaid detail={failure.detail} kind="listing" />
        </div>
      ) : failure ? (
        // Y-775: Readiness owns the cause and the one "What ssh said".
        <div className="machine__failed" role="status">
          <State state="unknown">The sessions cannot be listed</State>
        </div>
      ) : sessions.looked === 'failed' ? (
        <ErrorSurface.Inline error={fromReading(sessions)!} title="The sessions could not be read" />
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
                <Text className="machine__age" scale="body-small" tone="variant">
                  <Since at={session.created_at} plain />
                </Text>
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

      {/* D7 N2: said only beside a Kill. */}
      {rows.length > 0 ? (
        <Text render={<p />} className="machine__note" scale="body-small" tone="variant">
          Kill asks first; it cannot be undone. A session no workspace claims is not adopted: its
          repository is not on the wire, so a workspace for it starts at New session.
        </Text>
      ) : null}
    </Card>
  )
}
