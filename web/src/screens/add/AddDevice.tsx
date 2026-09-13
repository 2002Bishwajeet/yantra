import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { Check, Plus } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import type { Machine } from '@/api'
import { asApiError } from '@/api/errors'
import { useAbout, useMachines, useNotifications, useReadiness } from '@/api/hooks'
import { useInstall, useRecheckReadiness } from '@/api/mutations'
import { machineReadinessQuery } from '@/api/queries'
import { joinUrl } from '@/lib/join'
import { asPlatform, guessPlatform, PLATFORMS, platformName, platformOf, type Platform } from '@/lib/platform'
import { Button } from '@/m3/button/Button'
import { Copyable } from '@/m3/copyable/Copyable'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State, type MarkState } from '@/m3/mark/Mark'
import { Segment, Segmented } from '@/m3/segmented/Segmented'
import { Text } from '@/m3/text/Text'
import { asEvents } from '@/shell/notifications'
import { useScreenTitle } from '@/shell/title'
import { Join } from '@/screens/setup/Join'
import { joined, lastAsk, lastInstall, newDevice, onTailnet, reachable, ready, type Beat, type BeatState } from './beats'
import './AddDevice.css'

type Session = 'linux' | 'macOS'

const marks: Record<BeatState, MarkState> = { waiting: 'idle', done: 'done', stuck: 'needs' }

// Tailscale's and Homebrew's own commands, as their download pages print them.
const TAILSCALE = 'curl -fsSL https://tailscale.com/install.sh | sh'
const HOMEBREW = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

function Step(props: { n: number; title: string; beat: Beat; children?: ReactNode }) {
  const { n, title, beat, children } = props
  return (
    <li className="add__beat" data-state={beat.state}>
      <span aria-hidden="true" className="add__n">
        {beat.state === 'done' ? <Check /> : n}
      </span>
      <div className="add__body">
        <Text emphasized render={<h2 />} scale="title-medium">
          {title}
        </Text>
        <div aria-live="polite">
          <State size="small" state={marks[beat.state]}>
            {beat.state} · {beat.words}
          </State>
        </div>
        {beat.error ? <ErrorSurface.Inline error={asApiError(beat.error)} title={beat.words} /> : null}
        {children}
      </div>
    </li>
  )
}

function Note(props: { children: ReactNode }) {
  return (
    <Text scale="body-small" tone="variant">
      {props.children}
    </Text>
  )
}

function Tailscale(props: { platform: Exclude<Platform, 'windows'> }) {
  const { platform } = props
  if (platform === 'linux') {
    return (
      <>
        <Note>Install Tailscale on it, then log in with the account the appliance uses:</Note>
        <Copyable text={TAILSCALE} what="Tailscale's install command" />
        <Copyable text="sudo tailscale up" what="Tailscale's login command" />
      </>
    )
  }
  const store = platform === 'macOS' ? 'the Mac App Store or as the standalone package' : 'the App Store or Google Play'
  const page = platform === 'macOS' ? 'https://tailscale.com/download/mac' : 'https://tailscale.com/download'
  return (
    <Note>
      Install Tailscale from {store}, then log in with the account the appliance uses ·{' '}
      <a className="add__link" href={page} rel="noreferrer" target="_blank">
        {page.replace('https://', '')}
      </a>
    </Note>
  )
}

/** Walk-through §3.2: from beat 2 the flow can move to the new device, where
 *  the join command is one tap to copy. */
function OpenThere(props: { href: string; device: string }) {
  const { href, device } = props
  return (
    <div className="add__there">
      <div className="add__qr">
        <QRCodeSVG aria-label={`A QR code for ${href}`} role="img" size={112} value={href} />
      </div>
      <div className="add__body">
        <Note>Or open this on {device}, where it is one tap to copy:</Note>
        <Copyable text={href} what="this page's address" />
      </div>
    </div>
  )
}

function useHere(platform: Platform, machine: string | undefined) {
  const router = useRouter()
  return new URL(router.buildLocation({ to: '/add', search: { platform, machine } }).href, location.origin).href
}

function JoinHere(props: { platform: Session; name: string | undefined }) {
  const { platform, name } = props
  const about = useAbout()
  const here = useHere(platform, name)
  return (
    <>
      {platform === 'macOS' ? (
        <Note>
          First turn on Remote Login in System Settings → General → Sharing. The join command cannot turn it on for you.
        </Note>
      ) : null}
      <Note>
        Run this once in a terminal on {name ?? 'the new device'}. It adds this appliance's key to the account that runs
        it and tells the appliance which account that is.
      </Note>
      <Join about={about} url={joinUrl(location, about.data)} what="the join command" />
      <OpenThere device={name ?? 'the new device'} href={here} />
    </>
  )
}

const later = (words: string): Beat => ({ state: 'waiting', words })

/** Beats 2 to 4 before there is a device to follow: drawn, and waiting. */
function Ahead(props: { platform: Session; name: string | undefined }) {
  return (
    <>
      <Step beat={later('waits for the device to be on the tailnet')} n={2} title="Joined">
        <JoinHere name={props.name} platform={props.platform} />
      </Step>
      <Step beat={later('waits for the join')} n={3} title="Reachable over ssh" />
      <Step beat={later('waits for ssh')} n={4} title="Ready" />
    </>
  )
}

/** Beats 2 to 4 for one device: the ring and its readiness, both read. */
function Following(props: { machine: Machine; platform: Session }) {
  const { machine, platform } = props
  const name = machine.name
  const notifications = useNotifications()
  const events = asEvents(notifications.data)
  const own = useQuery({ ...machineReadinessQuery(name), enabled: false }).data
  const sweep = useReadiness()
  const report =
    own?.looked === 'ok'
      ? own.data
      : sweep.looked === 'ok'
        ? (sweep.data.find((one) => one.machine === name) ?? null)
        : null
  const recheck = useRecheckReadiness()
  const install = useInstall()
  const ask = recheck.mutate

  // One ask per join or install seen arriving while the page is open: a person
  // started each, and nothing here runs on a timer (ADR-0019).
  const newest = lastAsk(events, name)
  const [baseline, setBaseline] = useState<number | null>(null)
  if (baseline === null && notifications.data !== undefined) setBaseline(newest)
  useEffect(() => {
    if (baseline !== null && newest > baseline) ask(name)
  }, [ask, baseline, name, newest])

  // The install answers 202; it is running until an install event newer than
  // the one before the press arrives.
  const [since, setSince] = useState<number | null>(null)
  const installing = install.isPending || (install.isSuccess && since !== null && lastInstall(events, name) <= since)
  const press = () => {
    setSince(lastInstall(events, name))
    install.mutate(name)
  }

  const asking = { pending: recheck.isPending, error: recheck.error }
  const second = joined(name, events, notifications.error, report)
  const third = reachable(second, name, report, events, asking, platform)
  const fourth = ready(third, name, report, events, asking, { pending: installing, error: install.error })
  const check = (words: string) => (
    <Button disabled={recheck.isPending} onClick={() => ask(name)} variant="text">
      {recheck.isPending ? 'asking…' : words}
    </Button>
  )

  return (
    <>
      <Step beat={second} n={2} title="Joined">
        {second.state === 'done' ? null : <JoinHere name={name} platform={platform} />}
      </Step>
      <Step beat={third} n={3} title="Reachable over ssh">
        {second.state === 'done' && third.state !== 'done' ? <div className="add__actions">{check('Check')}</div> : null}
      </Step>
      <Step beat={fourth} n={4} title="Ready">
        {third.state === 'done' && fourth.state !== 'done' ? (
          <>
            {fourth.commands?.length ? (
              <>
                <Note>Run each in a terminal on {name}; sudo asks for your password there:</Note>
                {fourth.commands.map((command) => (
                  <Copyable key={command} text={command} what={`the command for ${name}`} />
                ))}
              </>
            ) : null}
            {platform === 'macOS' ? (
              <>
                <Note>On a Mac, Install needs Homebrew for tmux and git. Without it, install Homebrew first:</Note>
                <Copyable text={HOMEBREW} what="Homebrew's install command" />
                <Note>Or, for git alone, Apple's Command Line Tools open a dialog on the Mac:</Note>
                <Copyable text="xcode-select --install" what="the Command Line Tools command" />
              </>
            ) : null}
            <div className="add__actions">
              {installing ? null : <Button onClick={press}>Install</Button>}
              {check('Check again')}
            </div>
          </>
        ) : null}
        {fourth.state === 'done' ? (
          <div className="add__actions">
            <Button icon={<Plus />} render={<Link to="/new" />} role="link">
              New session
            </Button>
          </div>
        ) : null}
      </Step>
    </>
  )
}

function Candidates(props: { list: Machine[]; platform: Platform }) {
  const { list, platform } = props
  return (
    <>
      <Note>Already on the tailnet? Pick it:</Note>
      <ul className="add__candidates">
        {list.map((one) => (
          <li key={one.name}>
            <Button render={<Link search={{ platform, machine: one.name }} to="/add" />} role="link" variant="outlined">
              {one.name}
            </Button>
          </li>
        ))}
      </ul>
    </>
  )
}

function Flow(props: { platform: Exclude<Platform, 'windows'>; named: string | undefined }) {
  const { platform, named } = props
  const machines = useMachines()
  const navigate = useNavigate({ from: '/add' })
  const dashboard = `${location.origin}/`

  // The nodes there were when the flow opened; the first new one of this
  // platform is the device, and the address keeps it through a reload.
  const [seen, setSeen] = useState<string[] | null>(null)
  if (seen === null && machines.looked === 'ok') setSeen(machines.data.map((one) => one.name))
  const list = machines.looked === 'ok' ? machines.data : []
  const fresh = named ? undefined : newDevice(list, seen, platform)
  useEffect(() => {
    if (fresh) void navigate({ search: { platform, machine: fresh }, replace: true })
  }, [fresh, navigate, platform])

  const first = onTailnet(machines, named, platform)
  const candidates = named ? [] : list.filter((one) => platformOf(one) === platform)
  return (
    <ol className="add__beats">
      <Step beat={first} n={1} title="On the tailnet">
        {first.state === 'done' ? null : <Tailscale platform={platform} />}
        {candidates.length ? <Candidates list={candidates} platform={platform} /> : null}
      </Step>
      {platform === 'phone' ? (
        <li className="add__beat" data-state="last">
          <span aria-hidden="true" className="add__n">
            2
          </span>
          <div className="add__body">
            <Text emphasized render={<h2 />} scale="title-medium">
              Open the dashboard there
            </Text>
            <Note>
              Open this address on the phone or tablet, then add it to the home screen: Share → Add to Home Screen on
              an iPhone or iPad, the browser menu → Add to Home screen on Android. It opens the dashboard and runs no
              session, so nothing here waits on it.
            </Note>
            <OpenThere device={named ?? 'the phone or tablet'} href={dashboard} />
          </div>
        </li>
      ) : first.machine && first.state === 'done' ? (
        <Following machine={first.machine} platform={platform} />
      ) : (
        <Ahead name={named} platform={platform} />
      )}
    </ol>
  )
}

function Windows() {
  return (
    <section aria-labelledby="add-windows" className="add__soon">
      <Text emphasized id="add-windows" render={<h2 />} scale="title-medium">
        Windows · coming soon
      </Text>
      <Note>
        A Windows machine cannot run a session yet: tmux and /bin/sh are not there, and how a session survives on
        Windows is still being worked out. Until then, a Windows machine on the tailnet opens the dashboard like a phone
        does.
      </Note>
    </section>
  )
}

/** Walk-through §3: one guided flow per platform, each beat seen by the
 *  appliance and never declared. The platform is guessed from this browser and
 *  the person can change it (Q3.1). */
export function AddDevice() {
  useScreenTitle('Add a device')
  const search = useSearch({ from: '/add' })
  const navigate = useNavigate({ from: '/add' })
  const platform = search.platform ?? guessPlatform(navigator)
  return (
    <div className="add">
      <div className="add__head">
        <Text emphasized render={<h1 />} scale="display-small">
          Add a device
        </Text>
        <Text scale="body-medium" tone="variant">
          Pick what the new device is. Each step ticks itself when the appliance sees it happen.
        </Text>
      </div>
      <div className="add__pick">
        <Segmented
          label="Platform"
          onValueChange={(value) => void navigate({ search: { platform: asPlatform(value) }, replace: true })}
          value={platform}
        >
          {PLATFORMS.map((one) => (
            <Segment key={one} value={one}>
              {platformName[one]}
            </Segment>
          ))}
        </Segmented>
        <Note>{search.platform ? 'chosen by you' : 'guessed from this browser · pick another if it is wrong'}</Note>
      </div>
      {platform === 'windows' ? <Windows /> : <Flow key={platform} named={search.machine} platform={platform} />}
    </div>
  )
}
