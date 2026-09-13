import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import type { Machine } from '@/api'
import { fromReading } from '@/api/client'
import { asApiError } from '@/api/errors'
import { useAbout, useMachines, useNotifications, useReadiness } from '@/api/hooks'
import { keys } from '@/api/keys'
import { useRecheckReadiness } from '@/api/mutations'
import { machineReadinessQuery } from '@/api/queries'
import { joinUrl } from '@/lib/join'
import { asPlatform, guessPlatform, PLATFORMS, platformName, platformOf, type Platform } from '@/lib/platform'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Copyable } from '@/m3/copyable/Copyable'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State, type MarkState } from '@/m3/mark/Mark'
import { Segment, Segmented } from '@/m3/segmented/Segmented'
import { Stepper, type StepItem, type StepState } from '@/m3/stepper/Stepper'
import { Text } from '@/m3/text/Text'
import { asEvents } from '@/shell/notifications'
import { useScreenTitle } from '@/shell/title'
import { useTick } from '@/useTick'
import { Join } from '@/screens/setup/Join'
import { joined, LATE_MS, newDevice, onTailnet, reachable, ready, installable, type Beat, type BeatState } from './beats'
import { Track } from '@/m3/track/Track'
import { useAskOnArrival, useInstallOn } from './install'
import './AddDevice.css'

type Session = 'linux' | 'macos'

// Tailscale's and Homebrew's own commands, as their download pages print them.
const TAILSCALE = 'curl -fsSL https://tailscale.com/install.sh | sh'
const HOMEBREW = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

/** D7 §3.8: the encoder loads with this route, and only when a code is drawn. */
const Qr = lazy(() => import('qrcode.react').then((it) => ({ default: it.QRCodeSVG })))

const said: Record<BeatState, string> = { ahead: 'not yet', waiting: 'waiting', done: 'done', stuck: 'stuck' }
const marks: Record<BeatState, MarkState> = { ahead: 'idle', waiting: 'running', done: 'done', stuck: 'needs' }
const steps: Record<BeatState, StepState> = { ahead: 'ahead', waiting: 'current', done: 'done', stuck: 'stuck' }

function Note(props: { children: ReactNode }) {
  return (
    <Text scale="body-small" tone="variant">
      {props.children}
    </Text>
  )
}

function Words(props: { beat: Beat; reset?: () => void; children?: ReactNode }) {
  const { beat, reset, children } = props
  return (
    <>
      <div aria-live="polite">
        <State size="small" state={marks[beat.state]}>
          {said[beat.state]} · {beat.words}
        </State>
      </div>
      {beat.error ? <ErrorSurface.Inline error={asApiError(beat.error)} reset={reset} title={beat.words} /> : null}
      {children}
    </>
  )
}

function item(title: string, beat: Beat, body?: ReactNode, options: { reset?: () => void; after?: ReactNode } = {}): StepItem {
  return {
    title: (
      <Text emphasized render={<h2 />} scale="title-medium">
        {title}
      </Text>
    ),
    state: steps[beat.state],
    words: (
      <Words beat={beat} reset={options.reset}>
        {options.after}
      </Words>
    ),
    body,
  }
}

function Code(props: { href: string }) {
  return (
    <div className="add-device__qr">
      <Suspense fallback={<div className="add-device__qr-wait" />}>
        <Qr aria-label={`A QR code for ${props.href}`} role="img" size={112} value={props.href} />
      </Suspense>
    </div>
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
  const store = platform === 'macos' ? 'the Mac App Store or as the standalone package' : 'the App Store or Google Play'
  const page = platform === 'macos' ? 'https://tailscale.com/download/mac' : 'https://tailscale.com/download'
  return (
    <Note>
      Install Tailscale from {store}, then log in with the account the appliance uses ·{' '}
      <a className="add-device__link" href={page} rel="noreferrer" target="_blank">
        {page.replace('https://', '')}
      </a>
    </Note>
  )
}

function useHere(platform: Platform, machine: string | undefined) {
  const router = useRouter()
  return new URL(router.buildLocation({ to: '/machines/add', search: { platform, machine } }).href, location.origin).href
}

/** Beat 2's body: the command, and this page on the new device (walk-through
 *  §3.2), where it is one tap to copy. */
function JoinHere(props: { platform: Session; name: string | undefined }) {
  const { platform, name } = props
  const about = useAbout()
  const here = useHere(platform, name)
  const device = name ?? 'the new device'
  return (
    <div className="add-device__join">
      <div className="add-device__join-text">
        {platform === 'macos' ? (
          <Note>
            First turn on Remote Login: System Settings → General → Sharing. The join command cannot turn it on for you.
          </Note>
        ) : null}
        <Note>
          Run this once in a terminal on {device}. It adds this appliance's key to the account that runs it and tells
          the appliance which account that is.
        </Note>
        <Join about={about} url={joinUrl(location, about.data)} what="the join command" />
        <Note>Or open this on {device}, where the command is one tap to copy:</Note>
        <Copyable text={here} what="this page's address" />
      </div>
      <Code href={here} />
    </div>
  )
}

function Candidates(props: { list: Machine[]; platform: Platform }) {
  const { list, platform } = props
  return (
    <>
      <Note>Already on the tailnet? Pick it:</Note>
      <ul className="add-device__candidates">
        {list.map((one) => (
          <li key={one.name}>
            <Button render={<Link search={{ platform, machine: one.name }} to="/machines/add" />} role="link" variant="outlined">
              {one.name}
            </Button>
          </li>
        ))}
      </ul>
    </>
  )
}

const later = (words: string): Beat => ({ state: 'ahead', words })

/** Beats 2 to 4 for one device: the ring and its readiness, both read. */
function Following(props: { first: StepItem; machine: Machine; platform: Session; now: number }) {
  const { first, machine, platform, now } = props
  // D7 §4.2: beat 2's three minutes start when it becomes current, which is
  // when beat 1 is done and this mounts, not when the flow opened.
  const [since] = useState(() => Date.now())
  const late = now - since >= LATE_MS
  const name = machine.name
  const client = useQueryClient()
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
  const ask = recheck.mutate
  const install = useInstallOn(name, events)
  useAskOnArrival(name, events, notifications.data !== undefined, ask)

  const asking = { pending: recheck.isPending, error: recheck.error }
  const second = joined(name, events, notifications.error, report, late)
  const third = reachable(second, name, report, events, asking, platform)
  const fourth = ready(third, name, report, events, asking, { pending: install.running, error: install.error })
  const again = (words: string) => (
    <Button disabled={recheck.isPending} onClick={() => ask(name)} variant="text">
      {recheck.isPending ? 'asking…' : words}
    </Button>
  )
  const fixes = installable(report)

  return (
    <Stepper
      className="add-device__beats"
      items={[
        first,
        item('Joined', second, <JoinHere name={name} platform={platform} />, {
          reset: () => void client.invalidateQueries({ queryKey: keys.notifications() }),
        }),
        item(
          'Reachable over ssh',
          third,
          third.state === 'ahead' ? undefined : <div className="add-device__actions">{again('Check again')}</div>,
        ),
        item(
          'Ready',
          fourth,
          fourth.state === 'ahead' ? undefined : (
            <>
              {install.running ? <Track label={`installing on ${name}`} /> : null}
              {fourth.commands?.length ? (
                <>
                  <Note>Run each in a terminal on {name}; sudo asks for your password there:</Note>
                  {fourth.commands.map((command) => (
                    <Copyable key={command} text={command} what={`the command for ${name}`} />
                  ))}
                </>
              ) : null}
              {platform === 'macos' && fixes ? (
                <>
                  <Note>On a Mac, Install needs Homebrew for tmux and git. Without it, install Homebrew first:</Note>
                  <Copyable text={HOMEBREW} what="Homebrew's install command" />
                  <Note>Or, for git alone, Apple's Command Line Tools open a dialog on the Mac:</Note>
                  <Copyable text="xcode-select --install" what="the Command Line Tools command" />
                </>
              ) : null}
              <div className="add-device__actions">
                {install.running ? null : fixes ? (
                  <Button onClick={install.press} variant={fourth.state === 'stuck' ? 'tonal' : 'filled'}>
                    Install
                  </Button>
                ) : (
                  <Button render={<Link params={{ machine: name }} to="/m/$machine" />} role="link" variant="tonal">
                    Open {name}
                  </Button>
                )}
                {again('Check again')}
              </div>
            </>
          ),
          {
            after:
              fourth.state === 'done' ? (
                <div className="add-device__actions">
                  <Button icon={<Plus />} render={<Link to="/new" />} role="link">
                    New session
                  </Button>
                </div>
              ) : undefined,
          },
        ),
      ]}
      orientation="vertical"
    />
  )
}

function Flow(props: { platform: Exclude<Platform, 'windows'>; named: string | undefined }) {
  const { platform, named } = props
  const machines = useMachines()
  const client = useQueryClient()
  const navigate = useNavigate({ from: '/machines/add' })
  const [opened] = useState(() => Date.now())
  const now = useTick(true)
  const late = now - opened >= LATE_MS

  // The nodes there were when the flow opened; the first new one of this
  // platform is the device, and the address keeps it through a reload.
  const [seen, setSeen] = useState<string[] | null>(null)
  if (seen === null && machines.looked === 'ok') setSeen(machines.data.map((one) => one.name))
  const list = machines.looked === 'ok' ? machines.data : []
  const fresh = named ? undefined : newDevice(list, seen, platform)
  useEffect(() => {
    if (fresh) void navigate({ search: { platform, machine: fresh }, replace: true })
  }, [fresh, navigate, platform])

  const first = onTailnet(machines, named, platform, late)
  const candidates = named ? [] : list.filter((one) => platformOf(one) === platform)
  const one = item(
    'On the tailnet',
    first,
    <>
      {machines.looked === 'failed' ? (
        <ErrorSurface.Inline
          error={fromReading(machines)!}
          reset={() => void client.invalidateQueries({ queryKey: keys.machines() })}
          title="The tailnet list could not be read"
        />
      ) : null}
      <Tailscale platform={platform} />
      {late && !named ? (
        <div className="add-device__actions">
          <Button render={<a href="https://login.tailscale.com/admin/machines" rel="noreferrer" target="_blank" />} role="link" variant="text">
            Open Tailscale
          </Button>
        </div>
      ) : null}
      {candidates.length ? <Candidates list={candidates} platform={platform} /> : null}
    </>,
  )

  if (platform === 'mobile') {
    return (
      <>
        <Stepper className="add-device__beats" items={[one]} orientation="vertical" />
        <Card className="add-device__card" surface="low">
          <Text emphasized render={<h2 />} scale="title-medium">
            Open the dashboard on it and add it to your home screen
          </Text>
          <Note>
            Share → Add to Home Screen on an iPhone or iPad, the browser menu → Add to Home screen on Android. It opens
            the dashboard and runs no session, so nothing here waits on it.
          </Note>
          <div className="add-device__join">
            <div className="add-device__join-text">
              <Copyable text={`${location.origin}/`} what="the dashboard's address" />
            </div>
            <Code href={`${location.origin}/`} />
          </div>
        </Card>
      </>
    )
  }
  if (first.machine && first.state === 'done') {
    return <Following first={one} machine={first.machine} now={now} platform={platform} />
  }
  return (
    <Stepper
      className="add-device__beats"
      items={[
        one,
        item('Joined', later('waits for the device to be on the tailnet'), <JoinHere name={named} platform={platform} />),
        item('Reachable over ssh', later('waits for the join')),
        item('Ready', later('waits for ssh')),
      ]}
      orientation="vertical"
    />
  )
}

function Windows() {
  return (
    <Card aria-labelledby="add-device-windows" className="add-device__card" surface="low">
      <Text emphasized id="add-device-windows" render={<h2 />} scale="title-medium">
        Windows · coming soon
      </Text>
      <Note>Windows is coming. Today a Windows PC can open the dashboard; it cannot run a session yet.</Note>
    </Card>
  )
}

/** D7 §4.2 and walk-through §3: one guided flow per platform, each beat seen by
 *  the appliance and never declared. The platform is guessed from this
 *  browser, and the person can change it (Q3.1). */
export function AddDevice() {
  useScreenTitle('Add a device')
  const search = useSearch({ from: '/machines/add' })
  const navigate = useNavigate({ from: '/machines/add' })
  const platform = search.platform ?? guessPlatform(navigator)
  return (
    <div className="add-device">
      <div className="add-device__head">
        <Text emphasized render={<h1 />} scale="display-small">
          Add a device
        </Text>
        <Text scale="body-medium" tone="variant">
          Each step ticks itself when Yantra sees it happen.
        </Text>
      </div>
      <div className="add-device__pick">
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
