import { Fragment, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { Activity, Clock, Cpu, HardDrive, Layers, MemoryStick, Monitor, Zap, type LucideIcon } from 'lucide-react'
import type { AgentRow, Beat, Machine as OneMachine, MachineSessions, Workspace } from '@/api'
import { fromReading } from '@/api/client'
import {
  loaded,
  type Reading,
  useAgents,
  useMachineReadiness,
  useMachines,
  useSessions,
  useWorkspaces,
} from '@/api/hooks'
import { apart, runsSessions } from '@/lib/platform'
import { at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Chip } from '@/m3/chip/Chip'
import { Disclosure } from '@/m3/disclosure/Disclosure'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { List, ListItem } from '@/m3/list/List'
import { Mark, State } from '@/m3/mark/Mark'
import { Page } from '@/m3/page/Page'
import { PageHeader } from '@/m3/page/PageHeader'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Text } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { Looked } from '@/screens/fleet/age'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { Verb } from '@/screens/fleet/Verb'
import { stateOf } from '@/screens/fleet/verbs'
import { gb, machineState } from '@/screens/machines/facts'
import { useFormFactor } from '@/shell/formFactor'
import { useTick } from '@/useTick'
import { daemonCouldNotRead, unreachable } from '@/work'
import { OwnerTerminal } from './OwnerTerminal'
import { ReadinessCard } from './Readiness'
import { useVerdict } from './useVerdict'
import { Sessions } from './Sessions'
import { chipOf, startable } from './verdict'
import './Machine.css'

/** ADR-0013 §2: power is a string or an object, so neither can be misread as
 *  the other. */
const power = (beat: Beat) =>
  beat.power === 'ac' ? 'on AC' : `battery ${beat.power.battery.percent}%`

/** A tile: the label with its icon, then the value. A `dt` and its `dd` share one `div`, so a reader gets each pair. */
function Fact(props: { label: string; icon: LucideIcon; children: ReactNode }) {
  const Icon = props.icon
  return (
    <div className="machine__fact">
      <Text render={<dt />} scale="label-medium" tone="variant">
        <Icon aria-hidden="true" />
        {props.label}
      </Text>
      <Text render={<dd />} scale="title-medium">
        {props.children}
      </Text>
    </div>
  )
}

/** The tailnet name without its root dot, breakable between labels only. */
function Tailnet(props: { name: string }) {
  const labels = props.name.replace(/\.$/, '').split('.')
  return (
    <Text className="machine__num" scale="body-medium">
      {labels.map((label, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <>
              .
              <wbr />
            </>
          ) : null}
          {label}
        </Fragment>
      ))}
    </Text>
  )
}

function About(props: { machine: OneMachine; lastSeen: string | null }) {
  const { machine, lastSeen } = props
  const { word } = machineState(machine)
  const beat = machine.heartbeat
  return (
    <>
      <dl className="machine__facts">
        <Fact icon={Monitor} label="OS">{machine.os}</Fact>
        <Fact icon={Activity} label="Status">{word}</Fact>
        {lastSeen && !machine.online ? (
          <Fact icon={Clock} label="Last seen">
            {/^\d+[smhd]$/.test(lastSeen) ? `${lastSeen} ago` : lastSeen}
          </Fact>
        ) : null}
        {beat ? (
          <>
            <Fact icon={Layers} label="Architecture">{beat.arch}</Fact>
            <Fact icon={Cpu} label="CPU">{beat.cpu_busy_pct}% busy</Fact>
            <Fact icon={MemoryStick} label="Memory">{gb(beat.free_ram_mb)} GB free</Fact>
            <Fact icon={HardDrive} label="Disk">{gb(beat.free_disk_mb)} GB free</Fact>
            <Fact icon={Zap} label="Power">{power(beat)}</Fact>
          </>
        ) : null}
      </dl>
      <List className="machine__named">
        <ListItem
          headline="Address"
          supporting={
            machine.address ? (
              <Text className="machine__num" scale="body-medium">
                {machine.address}
              </Text>
            ) : (
              'none reported'
            )
          }
        />
        <ListItem headline="Tailnet name" supporting={<Tailnet name={machine.dns_name} />} />
      </List>
    </>
  )
}

const ago = (lastSeen: string) => (/^\d+[smhd]$/.test(lastSeen) ? `${lastSeen} ago` : lastSeen)

/** Y-775: a phone, tablet or Windows PC runs no session, so it shows its state and nothing to press. */
function Apart(props: { machine: OneMachine; lastSeen: string | null; name: string }) {
  const { machine, lastSeen, name } = props
  // An offline phone in a pocket is normal, so only an expired key is an error.
  const asleep = !machine.online && !machine.expired
  const { state, word } = asleep ? { state: 'unknown' as const, word: 'asleep' } : machineState(machine)
  const seen = machine.online ? 'now' : lastSeen ? ago(lastSeen) : 'not seen'
  return (
    <Page>
      <PageHeader
        subtitle={
          <Chip tone={machine.expired ? 'error' : 'lowest'}>
            <Mark size="small" state={state} />
            {machine.online || !lastSeen ? word : `${word} · ${ago(lastSeen)}`}
          </Chip>
        }
        title={name}
      />
      <Card aria-labelledby="machine-device" className="machine__card" surface="container">
        <div className="machine__head">
          <Text render={<h2 />} emphasized id="machine-device" scale="title-large">
            This device
          </Text>
        </div>
        <dl className="machine__facts">
          <Fact icon={Activity} label="Status">{word}</Fact>
          <Fact icon={Clock} label="Last seen">{seen}</Fact>
        </dl>
        <Text render={<p />} scale="body-small" tone="variant">
          {apart(machine)}
        </Text>
      </Card>
    </Page>
  )
}

function Workspaces(props: { rows: AgentRow[]; pending: boolean; machine: string; ready: boolean }) {
  const { rows, pending, machine, ready } = props
  // D7 B3: a card with nothing in it and no way to start one says nothing.
  if (!pending && rows.length === 0 && !ready) return null
  return (
    <Card aria-labelledby="machine-workspaces" className="machine__card" surface="container">
      <div className="machine__head">
        <Text render={<h2 />} emphasized id="machine-workspaces" scale="title-large">
          Workspaces on this machine
        </Text>
        {rows.length > 0 ? (
          <Text className="machine__num" scale="body-small" tone="variant">
            {rows.length}
          </Text>
        ) : null}
      </div>
      {pending ? (
        <div aria-busy="true" className="machine__pending">
          <Skeleton shape="text" style={{ width: '64%' }} />
          <Skeleton shape="text" style={{ width: '48%' }} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No workspace lives here">
          <Link className="m3-hit" to="/new">New session</Link> puts one on {machine}
        </EmptyState>
      ) : (
        <ul className="machine__rows">
          {rows.map(({ workspace, status }) => {
            const { state, word } = stateOf(status)
            return (
              <li key={workspace.name}>
                <div className="machine__row">
                  <Tile name={workspace.name} />
                  <span className="machine__text">
                    <Link className="machine__name m3-hit" params={{ name: workspace.name }} to="/w/$name">
                      {workspace.name}
                    </Link>
                    <Text className="machine__where m3-clip" scale="body-small" tone="variant">
                      {workspace.repo}
                    </Text>
                  </span>
                  <State className="machine__state" state={state}>
                    {word}
                  </State>
                  <span className="machine__verbs">
                    <Verb status={status} workspace={workspace} />
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/** Y-775: nothing is known about the device yet, so the page shows no ssh or sudo control. */
function Unknown(props: { name: string; failed?: Reading<unknown> }) {
  const client = useQueryClient()
  const { name, failed } = props
  return (
    <Page>
      <PageHeader title={name} />
      {failed ? (
        <ErrorSurface.Inline
          error={fromReading(failed)!}
          reset={() => void client.invalidateQueries()}
          title="Machines could not be read"
        />
      ) : (
        <Card aria-busy="true" aria-label={name} className="machine__card" role="region" surface="container">
          <div className="machine__pending">
            <Skeleton shape="text" style={{ width: '56%' }} />
            <Skeleton shape="text" style={{ width: '72%' }} />
          </div>
        </Card>
      )}
    </Page>
  )
}

/** D7 §4.3: a machine is looked up first, so a phone, tablet or Windows PC never reaches
 *  the Readiness, Sessions or owner-terminal cards (Y-775). */
export function Machine() {
  const { machine: name } = useParams({ from: '/m/$machine' })
  const client = useQueryClient()
  const now = useTick(false)
  const machines = useMachines()
  const sessions = useSessions()
  const listed = loaded(useWorkspaces())

  const nothing = unreachable([machines, sessions, listed])
  if (nothing) {
    return (
      <Page>
        <PageHeader title={name} />
        <ErrorSurface.Page
          error={daemonCouldNotRead(nothing)}
          eyebrow="Machine"
          reset={() => void client.invalidateQueries()}
          title="The daemon could not read the fleet"
        />
      </Page>
    )
  }

  if (machines.looked === 'failed') return <Unknown failed={machines} name={name} />
  if (machines.looked !== 'ok') return <Unknown name={name} />

  const one = machines.data.find((m) => m.name === name)
  if (!one) {
    return (
      <Page>
        <PageHeader title={name} />
        <ErrorSurface.Page
          error={{
            kind: 'missing',
            said: `the tailnet lists no node called \`${name}\``,
            retryable: false,
            describe: () => `No machine is called ${name}.`,
          }}
          eyebrow="Machines"
          title="No such machine"
          action={
            <Button render={<Link to="/machines" />} role="link" variant="text">
              Machines
            </Button>
          }
        />
      </Page>
    )
  }

  const lastSeen = one.last_seen ? (at(one.last_seen, now)?.text ?? null) : null
  if (!runsSessions(one)) return <Apart lastSeen={lastSeen} machine={one} name={name} />
  return <Sessionful lastSeen={lastSeen} listed={listed} machine={one} machines={machines} name={name} sessions={sessions} />
}

function Sessionful(props: {
  name: string
  machine: OneMachine
  machines: Reading<OneMachine[]>
  sessions: Reading<MachineSessions[]>
  listed: Reading<Workspace[]>
  lastSeen: string | null
}) {
  const { name, machine: one, machines, sessions, listed, lastSeen } = props
  const factor = useFormFactor()
  const readiness = useMachineReadiness(name)
  const here: Reading<Workspace[]> =
    listed.looked === 'ok'
      ? { ...listed, data: listed.data.filter((one) => one.machine === name) }
      : listed
  const agents = useAgents(here)
  const answer = sessions.looked === 'ok' ? sessions.data.find((m) => m.machine === name) : undefined
  const verdicted = useVerdict(name, one, readiness, answer?.reached === 'no' ? answer.error : null)

  const chip = chipOf(verdicted.verdict, lastSeen)
  const rows = agents.looked === 'ok' ? agents.data : []

  return (
    <Page>
      <PageHeader
        stamp={<Looked plain reads={[machines, readiness, sessions]} />}
        subtitle={
          <Chip tone={chip.error ? 'error' : 'lowest'}>
            <Mark size="small" state={chip.state} />
            {chip.word}
          </Chip>
        }
        title={name}
      />

      <div className="machine__columns">
        <ErrorBoundary eyebrow={name} title="Readiness could not be drawn">
          <ReadinessCard lastSeen={lastSeen} name={name} readiness={readiness} state={verdicted} />
        </ErrorBoundary>

        <ErrorBoundary eyebrow={name} title="The workspaces could not be drawn">
          <Workspaces
            machine={name}
            pending={agents.looked === 'pending'}
            ready={startable(verdicted.verdict)}
            rows={rows}
          />
        </ErrorBoundary>

        <ErrorBoundary eyebrow={name} title="The sessions could not be drawn">
          <Sessions machine={name} sessions={sessions} verdict={verdicted.verdict} workspaces={here} />
        </ErrorBoundary>

        <ErrorBoundary eyebrow={name} title="The owner terminal could not be drawn">
          <OwnerTerminal key={name} machine={name} />
        </ErrorBoundary>

        <ErrorBoundary eyebrow={name} title="About could not be drawn">
          <Card aria-labelledby="machine-about" className="machine__card" surface="low">
            <div className="machine__head">
              <Text render={<h2 />} emphasized id="machine-about" scale="title-large">
                About
              </Text>
            </div>
            {factor === 'phone' ? (
              <Disclosure summary={`${one.os} · ${machineState(one).word}`}>
                <About lastSeen={lastSeen} machine={one} />
              </Disclosure>
            ) : (
              <About lastSeen={lastSeen} machine={one} />
            )}
          </Card>
        </ErrorBoundary>
      </div>
    </Page>
  )
}
