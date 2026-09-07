import { Link } from '@tanstack/react-router'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { State } from '@/m3/mark/Mark'
import { Row } from '@/m3/row/Row'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { Since } from '@/screens/fleet/age'
import { KillSession } from '@/screens/fleet/Confirm'
import { Empty } from '@/screens/fleet/Empty'
import type { Held } from './facts'

/** *Worth a look*: the tmux sessions the fleet does not account for. Attach
 *  and Kill only — D6 §4.3 refuses an Adopt button, since the repo a session
 *  was opened in is not on the wire. */
export function Unclaimed(props: { held: Held[]; pending: boolean }) {
  const { held, pending } = props
  return (
    <Card
      aria-labelledby="machines-unclaimed"
      className="machines__unclaimed"
      surface="tertiary"
    >
      <div className="machines__eyebrow">
        <Eyebrow as="h2" id="machines-unclaimed">
          Worth a look
        </Eyebrow>
        {held.length > 0 ? (
          <Text scale="body-small">
            {held.length} session{held.length === 1 ? '' : 's'} no workspace claims
          </Text>
        ) : null}
      </div>
      {pending ? (
        <div aria-busy="true" className="machines__pending">
          <Skeleton shape="text" style={{ width: '52%' }} />
        </div>
      ) : held.length === 0 ? (
        <Empty state="done" title="Nothing unaccounted for">
          every tmux session on the machines that answered belongs to a workspace
        </Empty>
      ) : (
        <ul className="machines__rows">
          {held.map(({ machine, session }) => (
            <li key={`${machine} ${session.name}`}>
              <Row className="machines__session" tone="translucent">
                <State className="machines__word" state="unknown">
                  unclaimed
                </State>
                <span className="machines__text">
                  <span className="machines__name m3-clip">{session.name}</span>
                  <span className="machines__where m3-clip">
                    {machine} · {session.windows} window{session.windows === 1 ? '' : 's'} · opened{' '}
                    <Since at={session.created_at} /> ago
                  </span>
                </span>
                <span className="machines__verbs">
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
                    Attach
                  </Button>
                  <KillSession
                    machine={machine}
                    row={
                      <Row>
                        <State state="unknown">unclaimed</State>
                        <span className="machines__text">
                          <span className="machines__name">{session.name}</span>
                          <Mono className="machines__where">
                            {machine} · {session.windows} window
                            {session.windows === 1 ? '' : 's'}
                          </Mono>
                        </span>
                      </Row>
                    }
                    session={session.name}
                    trigger={
                      <Button tone="error" variant="text">
                        Kill
                      </Button>
                    }
                  />
                </span>
              </Row>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
