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
import { List, ListItem, ListValue } from '@/m3/list/List'
import { Mark, State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { Looked } from '@/screens/fleet/age'
import { Empty } from '@/screens/fleet/Empty'
import { Verb } from '@/screens/fleet/Verb'
import { stateOf } from '@/screens/fleet/verbs'
import { machineState } from '@/screens/machines/facts'
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

function About(props: { machine: OneMachine }) {
  const { machine } = props
  const { word } = machineState(machine)
  const beat = machine.heartbeat
  return (
    <List className="machine__about">
      <ListItem headline="OS" trailing={<ListValue>{machine.os}</ListValue>} />
      <ListItem
        headline="Address"
        trailing={<ListValue>{machine.address ? <Mono>{machine.address}</Mono> : 'none reported'}</ListValue>}
      />
      <ListItem headline="Tailnet name" trailing={<ListValue><Mono>{machine.dns_name}</Mono></ListValue>} />
      <ListItem headline="Status" trailing={<ListValue>{word}</ListValue>} />
      <ListItem
        headline="Heartbeat"
        supporting={
          beat
            ? `${beat.arch} · ${beat.free_ram_mb.toLocaleString()} MB free · ${beat.cpu_busy_pct}% busy · ${power(beat)}`
            : 'nothing has ever arrived from this machine'
        }
        trailing={<ListValue>{beat ? `beat ${beat.age_seconds}s ago` : 'never'}</ListValue>}
      />
    </List>
  )
}

function Workspaces(props: { rows: AgentRow[]; pending: boolean; machine: string; ready: boolean }) {
  const { rows, pending, machine, ready } = props
  return (
    <Card aria-labelledby="machine-workspaces" className="machine__card">
      <div className="machine__head">
        <Text render={<h2 />} emphasized id="machine-workspaces" scale="title-large">
          Workspaces on this machine
        </Text>
        {rows.length > 0 ? <Mono>{rows.length}</Mono> : null}
      </div>
      {pending ? (
        <div aria-busy="true" className="machine__pending">
          <Skeleton shape="text" style={{ width: '64%' }} />
          <Skeleton shape="text" style={{ width: '48%' }} />
        </div>
      ) : rows.length === 0 ? (
        <Empty title="No workspace lives here">
          {/* D7 B3: offered only where a session can start. */}
          {ready ? (
            <>
              <Link to="/new">New session</Link> puts one on {machine}
            </>
          ) : (
            `A session can start on ${machine} once Readiness says it is ready`
          )}
        </Empty>
      ) : (
        <ul className="machine__rows">
          {rows.map(({ workspace, status }) => {
            const { state, word } = stateOf(status)
            return (
              <li key={workspace.name}>
                <div className="machine__row">
                  <Tile name={workspace.name} />
                  <span className="machine__text">
                    <Link className="machine__name" params={{ name: workspace.name }} to="/w/$name">
                      {workspace.name}
                    </Link>
                    <Mono className="machine__where m3-clip">{workspace.repo}</Mono>
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
  const verdicted = useVerdict(name, one, readiness)

  const nothing = unreachable([machines, readiness, sessions, listed])
  if (nothing) {
    return (
      <ErrorSurface.Page
        error={fromReading(machines)!}
        eyebrow={name}
        reset={() => void client.invalidateQueries()}
        title="Nothing here can be reached"
        unknowns={['off the tailnet', 'yantrad down']}
      />
    )
  }

  if (machines.looked === 'ok' && !one) {
    return (
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
    )
  }

  const lastSeen = one?.last_seen ? (at(one.last_seen, now)?.text ?? null) : null
  const chip = one ? chipOf(verdicted.verdict, lastSeen) : null
  const rows = agents.looked === 'ok' ? agents.data : []

  return (
    <div className="machine">
      <div className="machine__title">
        <Text render={<h1 />} className="machine__h1" emphasized scale="display-small">
          {name}
        </Text>
        {chip ? (
          <Chip tone={chip.error ? 'error' : 'lowest'}>
            <Mark size="small" state={chip.state} />
            {chip.word}
          </Chip>
        ) : null}
        <Looked className="machine__looked" reads={[machines, readiness, sessions]} />
      </div>

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
          <Sessions machine={name} sessions={sessions} workspaces={here} />
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
                  <About machine={one} />
                </Disclosure>
              ) : (
                <About machine={one} />
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
    </div>
  )
}
