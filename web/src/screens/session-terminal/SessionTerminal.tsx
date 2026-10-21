import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { useSessions } from '@/api/hooks'
import { ago } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Page } from '@/m3/page/Page'
import { PageHeader } from '@/m3/page/PageHeader'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { KillSession } from '@/screens/fleet/Confirm'
import { isAge } from '@/screens/fleet/clock'
import { KeyRow } from '@/screens/session/Keys'
import { Talk } from '@/screens/session/Talk'
import { Terminal } from '@/screens/session/Terminal'
import { useFormFactor } from '@/shell/formFactor'
import { useTick } from '@/useTick'
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
  const sessions = useSessions()
  const now = useTick(true)
  const host = sessions.looked === 'ok' ? sessions.data.find((one) => one.machine === machine) : null
  const one = host?.reached === 'yes' ? host.sessions.find((each) => each.name === session) : undefined
  return (
    <Page>
      <PageHeader
        actions={
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
        }
        // The route's own title, so the phone app bar and the page say the
        // same thing (`router.test.tsx`).
        title={`${session} on ${machine}`}
      />
      <div className="session-terminal__meta">
        <Text render={<p />} scale="body-small" tone="variant">
          <Mono>{session}</Mono> is a tmux session on{' '}
          <Link params={{ machine }} to="/m/$machine">
            {machine}
          </Link>{' '}
          that no workspace claims
        </Text>
        {/* The swept list says how old it is; a bar until it answers, so
            the line never flashes empty (EmptyStates board). */}
        {sessions.looked === 'pending' ? (
          <Skeleton className="session-terminal__age" shape="text" />
        ) : one ? (
          <Mono className="session-terminal__age">
            started {ago(now / 1000 - one.created_at, now).text}
            {isAge(now / 1000 - one.created_at) ? ' ago' : null} · {one.windows} window
            {one.windows === 1 ? '' : 's'}
          </Mono>
        ) : null}
      </div>
      <Talk machine={machine} />
      <Terminal
        height={factor === 'phone' ? '55vh' : '65vh'}
        key={`${machine}/${session}`}
        label={`tmux ${session} on ${machine}`}
        target={{ machine, session }}
      >
        {factor === 'phone' ? <KeyRow /> : null}
      </Terminal>
    </Page>
  )
}
