import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { Button } from '@/m3/button/Button'
import { Mono, Text } from '@/m3/text/Text'
import { IconTile } from '@/m3/tile/Tile'
import { KillSession } from '@/screens/fleet/Confirm'
import { KeyRow } from '@/screens/session/Keys'
import { Terminal } from '@/screens/session/Terminal'
import { useFormFactor } from '@/shell/formFactor'
import { TerminalSquare } from 'lucide-react'
import './SessionTerminal.css'

/** `getRouteApi` rather than the route object: this module is loaded *by* the
 *  route, so importing it back would be a cycle. */
const route = getRouteApi('/m/$machine/s/$session')

/** One tmux session, live, whether or not a workspace claims it (ADR-0022).
 *  Nothing is read before the socket: a session is known only to its machine,
 *  so the socket attaches, and a name that is not there comes back refused by
 *  name (ADR-0022 §5). */
export function SessionTerminal() {
  const { machine, session } = route.useParams()
  const factor = useFormFactor()
  const navigate = useNavigate()
  return (
    <div className="session-terminal">
      <header className="session-terminal__head">
        <div className="session-terminal__title">
          <IconTile>
            <TerminalSquare />
          </IconTile>
          <div className="session-terminal__name">
            <Text as="h1" scale="headline-medium" emphasized clip>
              {session}
            </Text>
            <Text as="p" scale="body-small" tone="variant">
              tmux session on{' '}
              <Link params={{ machine }} to="/m/$machine">
                {machine}
              </Link>{' '}
              · <Mono>{session}</Mono>
            </Text>
          </div>
        </div>
        <KillSession
          machine={machine}
          onDone={() => void navigate({ params: { machine }, to: '/m/$machine' })}
          session={session}
          trigger={
            <Button tone="error" variant="text">
              Kill
            </Button>
          }
        />
      </header>
      <Terminal
        height={factor === 'phone' ? '55vh' : '65vh'}
        key={`${machine}/${session}`}
        label={`tmux ${session} on ${machine}`}
        target={{ machine, session }}
      >
        {factor === 'phone' ? <KeyRow /> : null}
      </Terminal>
    </div>
  )
}
