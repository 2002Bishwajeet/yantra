import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { Terminal } from '@/components/Terminal'
import { Title } from '@/components/Title'

/** `getRouteApi` rather than the route object: this module is loaded *by* the
 *  route, so importing it back would be a cycle. */
const route = getRouteApi('/m/$machine/s/$session')

/** One tmux session, live, whether or not a workspace claims it (ADR-0022).
 *
 *  **Nothing is read before the socket, and `/w/{name}` reads the list first.**
 *  A workspace the daemon has never heard of is a typo worth catching without
 *  an ssh; a session is known only to its machine, so the socket attaches, and
 *  a name that is not there comes back refused by name (ADR-0022 §5). */
export function OneSession() {
  const { machine, session } = route.useParams()
  const navigate = useNavigate()

  return (
    <>
      <Title>
        {session} on {machine}
      </Title>
      <Terminal
        onClose={() =>
          void navigate({ params: { machine }, to: '/m/$machine' })
        }
        target={{ machine, session }}
      />
    </>
  )
}
