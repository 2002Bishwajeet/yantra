import { useId, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, GitBranch, LoaderCircle, Plus, Radio, TriangleAlert } from 'lucide-react'
import type { Event, Machine, Readiness } from '@/api'
import { fromReading } from '@/api/client'
import { asApiError } from '@/api/errors'
import { useRecheckReadiness } from '@/api/mutations'
import { joinUrl } from '@/lib/join'
import { apart, runsSessions } from '@/lib/platform'
import { ago } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Copyable } from '@/m3/copyable/Copyable'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Lead } from '@/m3/lead/Lead'
import { List, ListItem } from '@/m3/list/List'
import { State, type MarkState } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { Track } from '@/m3/track/Track'
import { useFab } from '@/shell/primary'
import { PrimaryAction } from '@/shell/PrimaryAction'
import { useScreenTitle } from '@/shell/title'
import { useTick } from '@/useTick'
import { password } from '@/screens/add-device/beats'
import { useAskOnArrival, useInstallOn } from '@/screens/add-device/install'
import { stamp } from '../dashboard/bands'
import { Join } from './Join'
import { REQUIRED, useChecklist } from './progress'
import { marks, statusWord, type Line, type Step } from './steps'
import './Setup.css'

const tones = { done: 'primary', progress: 'tertiary', todo: 'high', failed: 'error' } as const

/** D7 B5: the lead is the state — a tick when done, the number when not yet,
 *  a ring in progress, a warning when it could not be read. */
function lead(step: Step, fallback: ReactNode) {
  if (step.status === 'done') return <Check />
  if (step.status === 'progress') return <LoaderCircle />
  if (step.status === 'failed') return <TriangleAlert />
  return fallback
}

function Item(props: { title: string; step: Step; fallback: ReactNode; trailing?: ReactNode }) {
  const { title, step, fallback, trailing } = props
  return (
    <ListItem
      headline={title}
      leading={<Lead tone={tones[step.status]}>{lead(step, fallback)}</Lead>}
      supporting={
        <State size="small" state={marks[step.status]}>
          {statusWord[step.status]} · {step.words}
        </State>
      }
      trailing={trailing}
    />
  )
}

const newest = (events: Event[], machine: string) =>
  events.find((one) => one.machine === machine && (one.kind === 'installed' || one.kind === 'install_stopped')) ??
  null

/** D7 §4.1's machine lines: what each state says and the one action it
 *  offers. An asleep machine offers none, since ssh cannot answer it. */
function MachineLine(props: {
  machine: Machine
  line: Line
  report: Readiness | null
  events: Event[]
  read: boolean
  target: boolean
  join: ReactNode
}) {
  const { machine, line: said, report, events, read, target, join } = props
  const name = machine.name
  const recheck = useRecheckReadiness()
  const install = useInstallOn(name, events)
  const carried = useFab() !== null
  useAskOnArrival(name, events, read, recheck.mutate)
  const stop = newest(events, name)
  const blocked = said.kind === 'missing' && stop?.kind === 'install_stopped' && stop.commands.length > 0
  const view = said.kind === 'missing' && install.running ? 'installing' : blocked ? 'blocked' : said.kind

  const mark: Record<typeof view, MarkState> = {
    asleep: 'unknown',
    unchecked: 'idle',
    unreachable: 'unknown',
    refused: 'failed',
    missing: 'needs',
    installing: 'running',
    blocked: 'needs',
    ready: 'done',
  }
  const words =
    said.kind === 'asleep'
      ? `asleep${said.since ? ` · last seen ${said.since} ago` : ''}`
      : said.kind === 'unchecked'
        ? 'not checked yet · a check costs one ssh round trip'
        : said.kind === 'unreachable'
          ? said.words
          : said.kind === 'refused'
            ? 'the key was refused · run the join command on it'
            : said.kind === 'ready'
              ? `ready · ${said.present} of ${said.total}`
              : view === 'installing'
                ? `installing on ${name}…`
                : view === 'blocked'
                  ? password(report)
                  : said.installable
                    ? said.words
                    : `${said.words} · the machine page shows how`

  const check = (label: string) => (
    <Button disabled={recheck.isPending} onClick={() => recheck.mutate(name)} variant="text">
      {recheck.isPending ? 'asking…' : label}
    </Button>
  )
  const action =
    said.kind === 'asleep' || said.kind === 'ready' || view === 'installing'
      ? null
      : said.kind === 'unchecked'
        ? check('Check')
        : said.kind === 'missing' && said.installable && view !== 'blocked'
          ? (
              <Button onClick={install.press} variant={target && !carried ? 'filled' : 'tonal'}>
                {target ? `Install on ${name}` : 'Install'}
              </Button>
            )
          : said.kind === 'missing' && !said.installable
            ? (
                <Button render={<Link params={{ machine: name }} to="/m/$machine" />} role="link" variant="text">
                  Open
                </Button>
              )
            : check(report ? 'Check again' : 'Check')

  return (
    <li className="setup__line" data-kind={view}>
      {/* D7 §3.6: Install on the target is the FAB's while it can be pressed. */}
      {target ? (
        <PrimaryAction action={view === 'missing' ? { kind: 'install', machine: name, press: install.press } : null} />
      ) : null}
      <State size="small" state={mark[view]}>
        <span className="setup__machine">{name}</span>
      </State>
      {/* Where focus goes when the FAB's Install goes away under a reader. */}
      <div
        aria-live="polite"
        className="setup__said"
        data-fab-return={target ? '' : undefined}
        tabIndex={target ? -1 : undefined}
      >
        <Text
          className={said.kind === 'refused' || said.kind === 'unreachable' ? 'setup__bad' : undefined}
          scale="body-small"
          tone={said.kind === 'refused' || said.kind === 'unreachable' ? undefined : 'variant'}
        >
          {words}
        </Text>
        {said.kind === 'refused' ? join : null}
        {view === 'installing' ? <Track label={`installing on ${name}`} /> : null}
        {view === 'blocked'
          ? stop?.commands.map((command) => <Copyable key={command} text={command} what={`the command for ${name}`} />)
          : null}
        {recheck.error ? <ErrorSurface.Inline error={recheck.error} title={`${name} was not asked`} /> : null}
        {install.error ? <ErrorSurface.Inline error={install.error} title={`The install on ${name} did not start`} /> : null}
      </div>
      {action}
    </li>
  )
}

/** D7 §4.1: `/` until the appliance has its key and one machine is ready (the
 *  owner's ruling (b), 2026-09-13). Four steps are required; GitHub and push
 *  are for later. One button is filled, and it is the next required thing. */
export function Setup() {
  const now = useTick(true)
  const devices = useId()
  const later = useId()
  const { about, identity, machines, sweep, notifications, events, all, lines, steps, later: optional, done, next, target } =
    useChecklist(now)
  const carried = useFab() !== null

  const others = all.filter((one) => !runsSessions(one))
  const join = joinUrl(location, about.data)
  const read = stamp([
    { name: 'machines', reading: machines },
    { name: 'readiness', reading: sweep },
  ])

  useScreenTitle('Set up Yantra')
  return (
    <div className="setup">
      <div className="setup__head">
        <Text render={<h1 />} emphasized scale="display-small">
          Set up Yantra
        </Text>
        <Text scale="body-medium" tone="variant">
          Yantra runs AI agents on your own machines. Four steps get the first one ready, and each step checks itself.
        </Text>
      </div>
      {/* The target machine's line publishes Install itself. */}
      {next === 'install' ? null : (
        <PrimaryAction
          action={
            machines.looked === 'pending' || next === null
              ? null
              : next === 'add'
                ? { kind: 'add-device' }
                : { kind: 'new-session' }
          }
        />
      )}

      {machines.looked === 'pending' ? (
        <div className="setup__progress" data-slot="reading">
          <Skeleton shape="text" style={{ width: 200 }} />
          <Skeleton style={{ height: 320 }} />
        </div>
      ) : (
        <>
          <div className="setup__progress">
            <div className="setup__count">
              <Mono>
                {done} of {REQUIRED} done
              </Mono>
              {read ? (
                <Mono className="setup__stamp">
                  as of {ago(read.age, now).text}
                  {read.late.map((one) => ` · ${one.name} ${ago(one.age, now).text}`)}
                </Mono>
              ) : null}
            </div>
            <Track className="setup__track" label={`${done} of ${REQUIRED} steps done`} value={done / REQUIRED} />
          </div>

          <List className="setup__list">
            <Item
              fallback="1"
              step={steps.tailnet}
              title="The appliance is on your tailnet"
              trailing={
                <Button render={<Link params={{ category: 'about' }} to="/settings/$category" />} role="link" variant="text">
                  Open
                </Button>
              }
            />
            <Item
              fallback="2"
              step={steps.machine}
              title="Add a machine"
              trailing={
                <Button
                  icon={<Plus />}
                  render={<Link to="/machines/add" />}
                  role="link"
                  variant={next === 'add' && !carried ? 'filled' : 'tonal'}
                >
                  Add a device
                </Button>
              }
            />
            <li className="setup__sub">
              {identity.error ? (
                <ErrorSurface.Inline
                  error={asApiError(identity.error)}
                  reset={() => void identity.refetch()}
                  title="The appliance's key could not be read"
                />
              ) : (
                <Text scale="body-small" tone="variant">
                  {identity.data ? (
                    <>
                      this appliance's key · <Mono>{identity.data.fingerprint}</Mono>
                    </>
                  ) : (
                    'the key is made when the first machine joins'
                  )}
                </Text>
              )}
              {machines.looked === 'failed' ? (
                <ErrorSurface.Inline error={fromReading(machines)!} title="Machines could not be read" />
              ) : lines.length > 0 ? (
                <ul className="setup__lines">
                  {lines.map((one) => (
                    <MachineLine
                      events={events}
                      join={<Join about={about} url={join} what={`the join command for ${one.machine.name}`} />}
                      key={one.machine.name}
                      line={one.line}
                      machine={one.machine}
                      read={notifications.data !== undefined}
                      report={one.report}
                      target={next === 'install' && one.machine.name === target}
                    />
                  ))}
                </ul>
              ) : null}
              {others.length > 0 ? (
                <>
                  <Text id={devices} scale="label-large" tone="variant">
                    Devices that open the dashboard
                  </Text>
                  <ul aria-labelledby={devices} className="setup__lines">
                    {others.map((one) => (
                      <li className="setup__line" data-kind="apart" key={one.name}>
                        <span className="setup__machine">{one.name}</span>
                        <Text className="setup__said" scale="body-small" tone="variant">
                          {apart(one)}
                        </Text>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </li>
            <Item fallback="3" step={steps.ready} title="Get it ready" />
            <Item
              fallback="4"
              step={steps.first}
              title="Your first session"
              trailing={
                <Button icon={<Plus />} render={<Link to="/new" />} role="link" variant={next === 'session' && !carried ? 'filled' : 'tonal'}>
                  New session
                </Button>
              }
            />
          </List>

          <div className="setup__later">
            <Text id={later} render={<h2 />} scale="title-small" tone="variant">
              Later, when you want them
            </Text>
            <List aria-labelledby={later} className="setup__list">
              <Item
                fallback={<GitBranch />}
                step={optional.github}
                title="GitHub"
                trailing={
                  optional.github.status === 'done' ? undefined : (
                    <Button render={<Link params={{ category: 'providers' }} to="/settings/$category" />} role="link" variant="tonal">
                      Connect
                    </Button>
                  )
                }
              />
              <Item
                fallback={<Radio />}
                step={optional.push}
                title="Push to your phone"
                trailing={
                  optional.push.status === 'done' ? undefined : (
                    <Button render={<Link params={{ category: 'notifications' }} to="/settings/$category" />} role="link" variant="tonal">
                      Set up
                    </Button>
                  )
                }
              />
            </List>
          </div>
        </>
      )}

      <div className="setup__foot">
        <Text scale="body-medium" tone="variant">
          One step runs in a terminal: the join command, once on each new machine. Each step here re-checks itself
          every few seconds.
        </Text>
        <Button className="setup__skip" render={<Link to="/fleet" />} role="link" variant="text">
          Skip for now
        </Button>
      </div>
    </div>
  )
}
