import { useState } from 'react'
import { clsx } from 'clsx'
import { ExternalLink, Mic, Scale, Shield } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { Channel, Looked, Published, UpdateProgress } from '@/api'
import { fromReading } from '@/api/client'
import { useApplyUpdate, useSetChannel } from '@/api/mutations'
import { aboutQuery } from '@/api/queries'
import { Button } from '@/m3/button/Button'
import { type Described, ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Lead } from '@/m3/lead/Lead'
import { ListChevron, ListItem, ListValue } from '@/m3/list/List'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Segment, Segmented } from '@/m3/segmented/Segmented'
import { Mono, Text } from '@/m3/text/Text'
import { Track } from '@/m3/track/Track'
import { Group, Note } from './Group'
import { Sheet } from './Sheet'
import { Reload, refused } from './update'

/** While an update runs and the daemon restarts after it, About asks this
 *  often, so each step and the new version are seen soon (ADR-0027 §5). */
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
  const facts = about.data
  // Y-612: a page opened mid-update follows it as if it had asked.
  if (asked === null && facts?.update && facts.update.step !== 'failed') setAsked(facts.version)
  // The restart is a moment with no daemon; the facts already drawn stay.
  if (about.error && !(asked !== null && facts)) throw about.error

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
          <Fact label="Target" value={facts ? <Mono clip title={facts.target}>{facts.target}</Mono> : null} wide />
          <Fact label="Uptime" value={facts ? <Mono>{uptime(facts.uptime_seconds)}</Mono> : null} />
          <Fact
            label="Listens on"
            value={
              facts
                ? facts.listening_on.map((address) => (
                    <Mono className="settings__line" clip key={address} title={address}>
                      {address}
                    </Mono>
                  ))
                : null
            }
            wide
          />
          <Fact label="Reached at" value={<Mono>{location.host}</Mono>} />
          {facts?.published.looked === 'failed' ? null : (
            <Fact
              label="Published"
              value={facts ? <Release channel={facts.channel} published={facts.published} /> : null}
            />
          )}
        </dl>
        {facts?.published.looked === 'failed' ? (
          <ErrorSurface.Inline
            error={fromReading(facts.published)!}
            eyebrow="Published"
            title="The newest release could not be read"
          />
        ) : null}
        {facts ? <ChannelSwitch channel={facts.channel} /> : null}
        {facts ? (
          <Update
            asked={asked}
            onAsked={setAsked}
            progress={facts.update ?? null}
            published={facts.published}
            running={facts.version}
          />
        ) : null}
      </section>
      <Group label="Who can open the dashboard">
        <ListItem
          headline="Only devices on your tailnet"
          supporting="No separate login"
          trailing={facts?.tailnet ? <ListValue>{facts.tailnet}</ListValue> : undefined}
          leading={
            <Lead>
              <Shield />
            </Lead>
          }
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
        {/* ADR-0043 §1: the model's CC-BY-4.0 licence asks for this credit. */}
        <ListItem
          headline="Dictation model"
          leading={
            <Lead>
              <Mic />
            </Lead>
          }
          render={<a href="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2" rel="noreferrer" target="_blank" />}
          supporting={
            <>
              Parakeet-TDT-0.6B-v2 by NVIDIA · <span className="settings__licence">CC-BY-4.0</span>
            </>
          }
          trailing={<ListChevron />}
        />
      </Group>
      <Note>Yantra keeps no fleet state. The dashboard reads the machines each time.</Note>
    </>
  )
}

/** ADR-0027 §2. A failed read is drawn by the caller, never as current. */
function Release(props: {
  channel: Channel | null
  published: Exclude<Looked<Published>, { looked: 'failed' }>
}) {
  const { channel, published } = props
  if (published.looked === 'never') return <Text scale="body-medium" tone="variant">not asked yet</Text>
  const { version, newer } = published.data
  if (!newer) return <Mono>{version} · current</Mono>
  // The nightly's tag names no version, and it moves with each merge.
  const tag = channel === 'nightly' ? 'nightly' : `v${version}`
  return (
    <a className="m3-hit" href={`https://github.com/2002Bishwajeet/yantra/releases/tag/${tag}`} rel="noreferrer" target="_blank">
      <Mono>v{version} is out</Mono>
    </a>
  )
}

function isChannel(value: string): value is Channel {
  return value === 'stable' || value === 'nightly'
}

/** Y-662: the daemon rewrites the channel the update unit reads. Switching
 *  installs nothing; the next update does, and it never goes back a version. */
function ChannelSwitch(props: { channel: Channel | null }) {
  const { channel } = props
  const set = useSetChannel()
  const shown = set.isPending ? set.variables : channel
  return (
    <div className="settings__channel">
      <Segmented
        disabled={set.isPending}
        label="Release channel"
        onValueChange={(next) => {
          if (isChannel(next) && next !== channel) set.mutate(next)
        }}
        value={shown ?? ''}
      >
        <Segment value="stable">Stable</Segment>
        <Segment value="nightly">Nightly</Segment>
      </Segmented>
      {set.isPending ? (
        <Text render={<p role="status" />} scale="body-small" tone="variant">
          Looking up the latest {set.variables === 'nightly' ? 'Nightly' : 'Stable'} release.
        </Text>
      ) : (
        <Text render={<p />} scale="body-small" tone="variant">
          {channel === null ? (
            <>
              <Mono>/etc/yantra/channel</Mono> names no channel. Pick one to rewrite it.
            </>
          ) : (
            'Stable is each release. Nightly is the latest merge.'
          )}
        </Text>
      )}
      {set.error ? <ErrorSurface.Inline error={set.error} title="The channel did not change" /> : null}
    </div>
  )
}

/** ADR-0027 §3 on the wire: the daemon only asks, and the root unit installs
 *  and restarts it. The unit's progress file says how far it got (Y-612). The
 *  page learns the result from `version` on its next read, and offers a
 *  reload, because its chunks belong to the old build. */
function Update(props: {
  running: string
  published: Looked<Published>
  asked: string | null
  onAsked: (running: string) => void
  progress: UpdateProgress | null
}) {
  const { running, published, asked, onAsked, progress } = props
  const [open, setOpen] = useState(false)
  const update = useApplyUpdate()

  if (asked !== null && running !== asked) {
    return <Reload asked={asked} running={running} />
  }
  if (progress && progress.step !== 'failed') return <Progress progress={progress} />
  // A box whose updater predates Y-612 writes no progress.
  if (asked !== null && !progress) {
    return (
      <Text render={<p role="status" />} scale="body-medium" tone="variant">
        Updating from <Mono>{asked}</Mono>. The daemon installs the release and restarts. If nothing changes in a few
        minutes, the install failed: <Mono>journalctl -u yantra-update</Mono> on the box says why.
      </Text>
    )
  }
  const failed = progress ? <Failed said={progress.said} /> : null
  if (published.looked !== 'ok' || !published.data.newer) return failed

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
      {failed}
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

const STEPS = {
  resolving: 'Finding the current release',
  verifying: 'Checking the archive against SHA256SUMS',
  installing: 'Installing the release',
} as const

function mb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

/** The step, and while the archive arrives, how much of it has. */
function Progress(props: { progress: Exclude<UpdateProgress, { step: 'failed' }> }) {
  const { progress } = props
  if (progress.step !== 'downloading') {
    return (
      <Text render={<p role="status" />} scale="body-medium">
        {STEPS[progress.step]}…
      </Text>
    )
  }
  const { version, received, total } = progress
  const amount = total === null ? `${mb(received)} MB` : `${mb(received)} of ${mb(total)} MB`
  return (
    <div className="settings__progress" role="status">
      <Text render={<p />} scale="body-medium">
        Downloading v{version} · {amount}
      </Text>
      {total ? <Track aria-valuetext={amount} label="Downloaded" value={received / total} /> : null}
    </div>
  )
}

/** The unit's own words, which the daemon's account cannot read in the journal. */
const failure: Described = {
  kind: 'update',
  said: '',
  retryable: false,
  describe: () => 'Nothing was installed and nothing restarted.',
}

function Failed(props: { said: string }) {
  const { said } = props
  return (
    <div className="settings__failed">
      <ErrorSurface.Inline error={failure} eyebrow="Update" title="The update failed" />
      {said ? <pre className="settings__said">{said}</pre> : null}
      <Text render={<p />} scale="body-small" tone="variant">
        The whole log is on the box: <Mono>journalctl -u yantra-update</Mono>
      </Text>
    </div>
  )
}

function Fact(props: { label: string; value: React.ReactNode; wide?: boolean }) {
  const { label, value, wide } = props
  return (
    <div className={clsx('settings__fact', wide && 'settings__fact--wide')}>
      <dt>
        <Text scale="label-medium" tone="variant">
          {label}
        </Text>
      </dt>
      <dd>{value ?? <Skeleton shape="text" />}</dd>
    </div>
  )
}
