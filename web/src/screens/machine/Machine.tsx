import { Fragment, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import type { AgentRow, Beat, Machine as OneMachine, Workspace } from '@/api'
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
import { at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Chip } from '@/m3/chip/Chip'
import { Disclosure } from '@/m3/disclosure/Disclosure'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
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
import { unreachable } from '@/work'
import { ReadinessCard } from './Readiness'
import { useVerdict } from './useVerdict'
import { Sessions } from './Sessions'
import { chipOf, startable } from './verdict'
import './Machine.css'

/** ADR-0013 §2: power is a string or an object, so neither can be misread as
 *  the other. */
const power = (beat: Beat) =>
  beat.power === 'ac' ? 'on AC' : `battery ${beat.power.battery.percent}%`

/** One value column at every width; on the phone the value drops under its label. */
function Fact(props: { label: string; children: ReactNode }) {
  return (
    <>
      <Text render={<dt />} scale="body-medium" tone="variant">
        {props.label}
      </Text>
      <Text render={<dd />} className="machine__value" scale="body-medium">
        {props.children}
      </Text>
    </>
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
    <dl className="machine__about">
      <Fact label="OS">{machine.os}</Fact>
      <Fact label="Address">
        {machine.address ? (
          <Text className="machine__num" scale="body-medium">
            {machine.address}
          </Text>
        ) : (
          'none reported'
        )}
      </Fact>
      <Fact label="Tailnet name">
        <Tailnet name={machine.dns_name} />
      </Fact>
      <Fact label="Status">{word}</Fact>
      {lastSeen && !machine.online ? (
        <Fact label="Last seen">{/^\d+[smhd]$/.test(lastSeen) ? `${lastSeen} ago` : lastSeen}</Fact>
      ) : null}
      {beat ? (
        <>
          <Fact label="Architecture">{beat.arch}</Fact>
          <Fact label="CPU">{beat.cpu_busy_pct}% busy</Fact>
          <Fact label="Memory">{gb(beat.free_ram_mb)} GB free</Fact>
          <Fact label="Disk">{gb(beat.free_disk_mb)} GB free</Fact>
          <Fact label="Power">{power(beat)}</Fact>
        </>
      ) : null}
    </dl>
  )
}

function Workspaces(props: { rows: AgentRow[]; pending: boolean; machine: string; ready: boolean }) {
  const { rows, pending, machine, ready } = props
  // D7 B3: a card with nothing in it and no way to start one says nothing.
  if (!pending && rows.length === 0 && !ready) return null
  return (
    <Card aria-labelledby="machine-workspaces" className="machine__card">
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

/** D7 §4.3: header, then Readiness — whose verdict decides the one action —
 *  then Workspaces, Sessions and About. */
export function Machine() {
  const { machine: name } = useParams({ from: '/m/$machine' })
  const client = useQueryClient()
  const factor = useFormFactor()
  const now = useTick(false)
  const machines = useMachines()
  const readiness = useMachineReadiness(name)
  const sessions = useSessions()
  const listed = loaded(useWorkspaces())
  const here: Reading<Workspace[]> =
    listed.looked === 'ok'
      ? { ...listed, data: listed.data.filter((one) => one.machine === name) }
      : listed
  const agents = useAgents(here)
  const one = machines.looked === 'ok' ? machines.data.find((m) => m.name === name) : undefined
  const answer = sessions.looked === 'ok' ? sessions.data.find((m) => m.machine === name) : undefined
  const verdicted = useVerdict(name, one, readiness, answer?.reached === 'no' ? answer.error : null)

  const nothing = unreachable([machines, readiness, sessions, listed])
  if (nothing) {
    return (
      <Page>
        <PageHeader title={name} />
        <ErrorSurface.Page
          error={fromReading(machines)!}
          eyebrow="Machine"
          reset={() => void client.invalidateQueries()}
          title="Nothing here can be reached"
          unknowns={['off the tailnet', 'yantrad down']}
        />
      </Page>
    )
  }

  if (machines.looked === 'ok' && !one) {
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

  const lastSeen = one?.last_seen ? (at(one.last_seen, now)?.text ?? null) : null
  const chip = one ? chipOf(verdicted.verdict, lastSeen) : null
  const rows = agents.looked === 'ok' ? agents.data : []

  return (
    <Page>
      <PageHeader
        stamp={<Looked reads={[machines, readiness, sessions]} />}
        subtitle={
          chip ? (
            <Chip tone={chip.error ? 'error' : 'lowest'}>
              <Mark size="small" state={chip.state} />
              {chip.word}
            </Chip>
          ) : null
        }
        title={name}
      />

      {machines.looked === 'failed' ? (
        <ErrorSurface.Inline
          error={fromReading(machines)!}
          reset={() => void client.invalidateQueries()}
          title="Machines could not be read"
        />
      ) : null}

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

        <ErrorBoundary eyebrow={name} title="About could not be drawn">
          <Card aria-labelledby="machine-about" className="machine__card">
            <div className="machine__head">
              <Text render={<h2 />} emphasized id="machine-about" scale="title-large">
                About
              </Text>
            </div>
            {one ? (
              factor === 'phone' ? (
                <Disclosure summary={`${one.os} · ${machineState(one).word}`}>
                  <About lastSeen={lastSeen} machine={one} />
                </Disclosure>
              ) : (
                <About lastSeen={lastSeen} machine={one} />
              )
            ) : (
              <div aria-busy="true" className="machine__pending">
                <Skeleton shape="text" style={{ width: '56%' }} />
                <Skeleton shape="text" style={{ width: '72%' }} />
              </div>
            )}
          </Card>
        </ErrorBoundary>
      </div>
    </Page>
  )
}
