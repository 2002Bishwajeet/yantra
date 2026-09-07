import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import type { Workspace, WorkspaceStatus } from '@/api'
import { useSessions, useSpend, useTranscript, useWorkspaces } from '@/api/hooks'
import { useResume } from '@/api/mutations'
import { MISSING, statusQuery } from '@/api/queries'
import { at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Pill, PillGroup } from '@/m3/pill/Pill'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { useFormFactor } from '@/shell/formFactor'
import { useTick } from '@/useTick'
import { VIEWS, type View } from '@/views'
import { Chat } from './Chat'
import { Delete, Header } from './Header'
import { KeyRow } from './Keys'
import { NotFound } from './NotFound'
import { Spend } from './Spend'
import { Terminal } from './Terminal'
import { Transcript } from './Transcript'
import { startedAt, verbs } from './verbs'
import './Session.css'

/** `getRouteApi` rather than the route object: this module is loaded *by* the
 *  route, so importing it back would be a cycle. */
const route = getRouteApi('/w/$name')

const LABELS: Record<View, string> = {
  chat: 'Chat',
  terminal: 'Terminal',
  transcript: 'Transcript',
  spend: 'Spend',
}

/** One workspace, four views the URL carries (D5 §3, board 13 puts Chat
 *  first). The list is read before any socket is opened: a round trip to the
 *  daemon is cheap and an attach is an ssh to a machine that may be asleep. */
export function Session() {
  const { name } = route.useParams()
  const { view } = route.useSearch()
  return <Workspace name={name} view={view ?? 'chat'} />
}

/** The route's body, with the URL already read — what the tests render. */
export function Workspace(props: { name: string; view: View }) {
  const { name, view } = props
  const listed = useWorkspaces()

  if (listed.looked === 'pending') {
    return (
      <>
        <Text as="h1" scale="headline-medium" emphasized>
          {name}
        </Text>
        <div aria-busy="true" className="session__pending">
          <Skeleton />
          <Skeleton shape="text" />
        </div>
      </>
    )
  }

  if (listed.looked !== 'ok') {
    return (
      <>
        <Text as="h1" scale="headline-medium" emphasized>
          {name}
        </Text>
        <ErrorSurface.Page
          error={{
            kind: 'network',
            said: listed.looked === 'failed' ? listed.error : '',
            retryable: false,
            describe: () =>
              listed.looked === 'failed'
                ? 'The daemon could not read its workspaces, so this one cannot be found.'
                : 'The daemon has not read its workspaces yet.',
          }}
          eyebrow="Session"
          title="The workspaces could not be read"
        />
      </>
    )
  }

  const entry = listed.data.find((one) => one.name === name)
  if (!entry) return <NotFound name={name} />

  if (entry.loaded === 'no') {
    return (
      <>
        <Text as="h1" scale="headline-medium" emphasized>
          {name}
        </Text>
        <Card className="session__broken" surface="error">
          <Text as="h2" scale="title-large">
            {name} is not usable.
          </Text>
          <Mono className="session__error">{entry.error}</Mono>
          {/* D3 §7.5: naming the error and offering nothing is what sent
              people to a terminal. Only the bytes fix this file (ADR-0020). */}
          <div>
            <Button role="link" render={<Link params={{ name }} to="/w/$name/repair" />} variant="tonal">
              Repair the file
            </Button>
          </div>
        </Card>
      </>
    )
  }

  return <Loaded view={view} workspace={entry} />
}

function Loaded(props: { workspace: Workspace; view: View }) {
  const { workspace, view } = props
  const { name } = workspace
  const sessions = useSessions()
  const factor = useFormFactor()
  const now = useTick(true)
  // Held above the tabs: only the open one is mounted, and switching to the
  // terminal and back may not spend a second ssh (D5 §3.5, §4.3).
  const transcript = useTranscript(name)
  const spend = useSpend()
  const resume = useResume()

  const { data: agent } = useQuery(statusQuery(name))
  const status: WorkspaceStatus | null =
    agent === undefined || agent === MISSING || agent.looked !== 'ok' ? null : agent.data
  const state = status?.reached === 'yes' ? status.status : null
  const paneOpen = startedAt(sessions, workspace) !== null
  const readAt = transcript.said.said === 'held' ? at(transcript.said.at, now) : null

  const endActions = (
    <div className="session__end-actions">
      <Button disabled={!verbs(workspace, status).resume || resume.isPending} onClick={() => resume.mutate(name)}>
        {resume.isPending ? 'Resuming…' : 'Resume'}
      </Button>
      <Delete
        status={status}
        trigger={
          <Button tone="error" variant="text">
            Delete
          </Button>
        }
        workspace={workspace}
      />
    </div>
  )

  return (
    <div className="session" data-view={view}>
      <Header now={now} sessions={sessions} status={status} workspace={workspace} />
      <div className="session__bar">
        {/* Links, not a tab widget: a tab here changes the URL, and that is
            navigation — middle-click and copy-link come free (D5 §3.2). A tab
            replaces the entry, so Back never walks through tabs (§3.4). */}
        <nav aria-label="Views">
          <PillGroup>
            {VIEWS.map((one) => (
              <Pill
                key={one}
                role="link"
                render={
                  <Link
                    aria-current={one === view ? 'page' : undefined}
                    params={{ name }}
                    replace
                    search={{ view: one }}
                    to="/w/$name"
                  />
                }
              >
                {LABELS[one]}
              </Pill>
            ))}
          </PillGroup>
        </nav>
        {readAt ? (
          <Mono className="session__read">
            read{' '}
            <time dateTime={readAt.iso} title={readAt.title}>
              {readAt.text}
            </time>{' '}
            ago · over ssh
          </Mono>
        ) : null}
      </div>
      {/* Only the open tab is mounted: mounting the terminal opens an ssh, and
          tmux redraws the pane for whoever attaches next (D5 §3.5). */}
      <ErrorBoundary eyebrow={`Session / ${LABELS[view]}`} layout="inline" resetKeys={[name, view]} title="This view broke">
        {view === 'chat' ? (
          <Chat
            endActions={endActions}
            key={name}
            now={now}
            onRead={transcript.read}
            paneOpen={paneOpen}
            said={transcript.said}
            state={state}
            workspace={workspace}
          />
        ) : null}
        {view === 'terminal' ? (
          <div className="session__terminal">
            {factor === 'phone' ? (
              <Text as="p" className="session__banner" scale="body-small" tone="variant">
                The terminal is the fallback;{' '}
                <Link params={{ name }} replace search={{ view: 'chat' }} to="/w/$name">
                  Chat
                </Link>{' '}
                is the session.
              </Text>
            ) : null}
            <Terminal
              height={factor === 'phone' ? '50vh' : '60vh'}
              key={name}
              label={`tmux ${name} on ${workspace.machine}`}
              target={{ workspace: name, machine: workspace.machine }}
            >
              {factor === 'phone' ? <KeyRow /> : null}
            </Terminal>
          </div>
        ) : null}
        {view === 'transcript' ? (
          <Transcript now={now} onRead={transcript.read} said={transcript.said} state={state} workspace={workspace} />
        ) : null}
        {view === 'spend' ? (
          <Spend asked={spend.asked} now={now} onAsk={() => void spend.ask(workspace)} workspace={workspace} />
        ) : null}
      </ErrorBoundary>
    </div>
  )
}
