import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { ApiError } from '@/api/errors'
import { useMachines } from '@/api/hooks'
import { keys } from '@/api/keys'
import { Button } from '@/m3/button/Button'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Page, PagePending } from '@/m3/page/Page'
import { PageHeader } from '@/m3/page/PageHeader'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Chat } from '@/screens/session/Chat'
import '@/screens/session/Session.css'

/** `getRouteApi` rather than the route object: the route loads this module. */
const route = getRouteApi('/m/$machine/home')

export function HomeChat() {
  const { machine } = route.useParams()
  const { thread } = route.useSearch()
  const navigate = route.useNavigate()
  // Replace, not push: naming the thread is the same page, and Back leaves it.
  const onThread = (id: string) => void navigate({ replace: true, search: { thread: id } })
  return (
    <ErrorBoundary eyebrow="Home chat" layout="page" resetKeys={[machine]} title="This chat broke">
      <Home machine={machine} onThread={onThread} thread={thread} />
    </ErrorBoundary>
  )
}

/** The body with the URL already read, which is what the tests render. */
export function Home(props: { machine: string; thread?: string; onThread: (thread: string) => void }) {
  const { machine, thread, onThread } = props
  const client = useQueryClient()
  const machines = useMachines()

  // A chat reads its thread only when its socket opens, so a thread picked from the menu
  // remounts it. A thread the chat itself named is already attached and does not.
  const [named, setNamed] = useState(thread)
  const [seen, setSeen] = useState(thread)
  const [epoch, setEpoch] = useState(0)
  if (thread !== seen) {
    setSeen(thread)
    if (thread !== named) {
      setNamed(thread)
      setEpoch(epoch + 1)
    }
  }

  if (machines.looked === 'pending') {
    return (
      <Page width="wide">
        <PageHeader title={machine} />
        <PagePending>
          <Skeleton shape="row" />
          <Skeleton shape="text" />
        </PagePending>
      </Page>
    )
  }

  if (machines.looked !== 'ok') {
    return (
      <Page width="wide">
        <PageHeader title={machine} />
        <ErrorSurface.Page
          error={
            new ApiError('network', machines.looked === 'failed' ? machines.error : '', {
              sentence:
                machines.looked === 'failed'
                  ? 'The daemon could not read its machines, so this one cannot be found.'
                  : 'The daemon has not read its machines yet.',
            })
          }
          eyebrow="Home chat"
          reset={() => void client.invalidateQueries()}
          title="The machines could not be read"
        />
      </Page>
    )
  }

  if (!machines.data.some((one) => one.name === machine)) {
    return (
      <Page width="wide">
        <PageHeader title={machine} />
        <ErrorSurface.Page
          action={
            <Button render={<Link to="/machines" />} role="link" variant="text">
              Machines
            </Button>
          }
          error={new ApiError('missing', machine, { sentence: `The tailnet has no machine called ${machine}.` })}
          eyebrow="Home chat"
          title="No such machine"
        />
      </Page>
    )
  }

  return (
    <Page className="session" width="wide">
      <PageHeader title={`Home on ${machine}`} />
      <div className="session__chat">
        <Chat
          key={`${machine}:${epoch}`}
          onThread={(id) => {
            setNamed(id)
            void client.invalidateQueries({ queryKey: keys.machineThreads(machine) })
            onThread(id)
          }}
          target={{ kind: 'home', machine }}
          thread={thread}
        />
      </div>
    </Page>
  )
}
