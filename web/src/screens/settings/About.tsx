import { useState } from 'react'
import { ExternalLink, FileKey, Scale } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { Looked, Published } from '@/api'
import { fromReading } from '@/api/client'
import type { ApiError } from '@/api/errors'
import { useApplyUpdate } from '@/api/mutations'
import { aboutQuery } from '@/api/queries'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Lead } from '@/m3/lead/Lead'
import { ListChevron, ListItem } from '@/m3/list/List'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { Group, Note } from './Group'
import { Sheet } from './Sheet'

/** While the daemon restarts after an update, About asks this often, so the
 *  new version is seen soon after it answers (ADR-0027 §5). */
const UPDATE_POLL_MS = 2_000

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `YYYY-MM-DD` as the brief's date: `6 Sep`. */
function built(date: string): string {
  const [, month, day] = date.split('-').map(Number)
  return month && day ? `${day} ${MONTHS[month - 1]}` : date
}

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3_600)
  const m = Math.floor((seconds % 3_600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

export function About() {
  // The version this page saw when the person asked for an update.
  const [asked, setAsked] = useState<string | null>(null)
  const about = useQuery({ ...aboutQuery(), ...(asked === null ? {} : { refetchInterval: UPDATE_POLL_MS }) })
  // The restart is a moment with no daemon; the facts already drawn stay.
  if (about.error && !(asked !== null && about.data)) throw about.error
  const facts = about.data

  return (
    <>
      <section aria-label="Daemon" className="settings__about">
        {facts ? (
          <Text render={<p />} className="settings__version" scale="title-large" emphasized>
            yantrad <Mono>{facts.version}</Mono> · built {built(facts.built)} · running
          </Text>
        ) : (
          <Skeleton shape="text" />
        )}
        <dl className="settings__facts">
          <Fact label="Target" value={facts ? <Mono>{facts.target}</Mono> : null} />
          <Fact label="Uptime" value={facts ? <Mono>{uptime(facts.uptime_seconds)}</Mono> : null} />
          <Fact label="Listens on" value={facts ? <Mono>{facts.listening_on.join(' · ')}</Mono> : null} />
          <Fact label="Reached at" value={<Mono>{location.host}</Mono>} />
          {facts?.published.looked === 'failed' ? null : (
            <Fact label="Published" value={facts ? <Release published={facts.published} /> : null} />
          )}
        </dl>
        {facts?.published.looked === 'failed' ? (
          <ErrorSurface.Inline
            error={fromReading(facts.published)!}
            eyebrow="Published"
            title="The newest release could not be read"
          />
        ) : null}
        {facts ? <Update asked={asked} onAsked={setAsked} published={facts.published} running={facts.version} /> : null}
      </section>
      <Group label="Daemon">
        <ListItem
          headline={<Mono>/etc/yantra/daemon.env</Mono>}
          leading={
            <Lead>
              <FileKey />
            </Lead>
          }
          supporting="0600 · the one file the daemon writes · the relay and the GitHub grant"
        />
      </Group>
      <Group label="Project">
        <ListItem
          headline="Licence"
          leading={
            <Lead>
              <Scale />
            </Lead>
          }
          supporting="BSD 3-Clause · Bishwajeet Parhi, 2026"
        />
        <ListItem
          headline="Source"
          leading={
            <Lead>
              <ExternalLink />
            </Lead>
          }
          render={<a href="https://github.com/2002Bishwajeet/yantra" rel="noreferrer" target="_blank" />}
          supporting="github.com/2002Bishwajeet/yantra"
          trailing={<ListChevron />}
        />
      </Group>
      <Note>Yantra persists nothing about the fleet. What you see on the dashboard is read from the machines each time.</Note>
    </>
  )
}

/** ADR-0027 §2. A failed read is drawn by the caller, never as current. */
function Release(props: { published: Exclude<Looked<Published>, { looked: 'failed' }> }) {
  const { published } = props
  if (published.looked === 'never') return <Text scale="body-medium" tone="variant">not asked yet</Text>
  const { version, newer } = published.data
  if (!newer) return <Mono>{version} · current</Mono>
  return (
    <a href={`https://github.com/2002Bishwajeet/yantra/releases/tag/v${version}`} rel="noreferrer" target="_blank">
      <Mono>v{version} is out</Mono>
    </a>
  )
}

/** ADR-0027 §3 on the wire: the daemon only asks, and the root unit installs
 *  and restarts it. The page learns the result from `version` on its next
 *  read, and offers a reload, because its chunks belong to the old build. */
function Update(props: {
  running: string
  published: Looked<Published>
  asked: string | null
  onAsked: (running: string) => void
}) {
  const { running, published, asked, onAsked } = props
  const [open, setOpen] = useState(false)
  const update = useApplyUpdate()

  if (asked !== null && running !== asked) {
    return (
      <div className="settings__update" role="status">
        <Text render={<p />} scale="body-medium">
          yantrad <Mono>{running}</Mono> is running. This page is still the <Mono>{asked}</Mono> dashboard.
        </Text>
        <Button onClick={() => location.reload()} variant="tonal">
          Reload
        </Button>
      </div>
    )
  }
  if (asked !== null) {
    return (
      <Text render={<p role="status" />} scale="body-medium" tone="variant">
        Updating from <Mono>{asked}</Mono>. The daemon installs the release and restarts. If nothing changes in a few
        minutes, the install failed: <Mono>journalctl -u yantra-update</Mono> on the box says why.
      </Text>
    )
  }
  if (published.looked !== 'ok' || !published.data.newer) return null

  const { version } = published.data
  const confirm = () =>
    update.mutate(undefined, {
      onSuccess: () => {
        setOpen(false)
        onAsked(running)
      },
    })

  return (
    <div className="settings__update">
      <Button onClick={() => setOpen(true)} variant="tonal">
        Update to v{version}
      </Button>
      <Sheet
        actions={
          <>
            <Button onClick={() => setOpen(false)} variant="text">
              Cancel
            </Button>
            <Button disabled={update.isPending} onClick={confirm}>
              {update.isPending ? 'asking…' : 'Update'}
            </Button>
          </>
        }
        description={`yantrad installs v${version} and restarts. A chat turn in flight dies with it. Open terminals reconnect to the same sessions, which keep running on their machines.`}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) update.reset()
        }}
        open={open}
        title={`Update to v${version}?`}
      >
        {update.error ? <ErrorSurface.Inline error={update.error} title={refused(update.error)} /> : null}
      </Sheet>
    </div>
  )
}

/** Each way the ask can fail is a different thing to fix. */
function refused(error: ApiError): string {
  if (error.kind === 'network') return 'The daemon did not answer, so no update was asked for'
  switch (error.status) {
    case 403:
      return 'This device may not update the daemon'
    case 409:
      return 'This box cannot update itself'
    case 503:
      return 'The daemon could not tell who is asking'
    default:
      return 'The update was refused'
  }
}

function Fact(props: { label: string; value: React.ReactNode }) {
  const { label, value } = props
  return (
    <div className="settings__fact">
      <dt>
        <Text scale="label-medium" tone="variant">
          {label}
        </Text>
      </dt>
      <dd>{value ?? <Skeleton shape="text" />}</dd>
    </div>
  )
}
