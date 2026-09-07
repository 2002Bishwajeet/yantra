import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import type { Beat, Machine as OneMachine, Workspace } from '@/api'
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
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Chip } from '@/m3/chip/Chip'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { List, ListItem, ListValue } from '@/m3/list/List'
import { Mark, State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import type { AgentRow } from '@/columns'
import { Looked } from '@/screens/fleet/age'
import { Empty } from '@/screens/fleet/Empty'
import { Verb } from '@/screens/fleet/Verb'
import { stateOf } from '@/screens/fleet/verbs'
import { Doctor } from '@/screens/machines/Doctor'
import { machineState, markOf, tally, wordOf } from '@/screens/machines/facts'
import { unreachable } from '@/work'
import { Sessions } from './Sessions'
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

function Workspaces(props: { rows: AgentRow[]; pending: boolean; machine: string }) {
  const { rows, pending, machine } = props
  return (
    <Card aria-labelledby="machine-workspaces" className="machine__card">
      <div className="machine__eyebrow">
        <Eyebrow as="h2" id="machine-workspaces">
          Workspaces on this machine
        </Eyebrow>
        {rows.length > 0 ? <Mono>{rows.length}</Mono> : null}
      </div>
      {pending ? (
        <div aria-busy="true" className="machine__pending">
          <Skeleton shape="text" style={{ width: '64%' }} />
          <Skeleton shape="text" style={{ width: '48%' }} />
        </div>
      ) : rows.length === 0 ? (
        <Empty title="No workspace lives here">
          <Link to="/new">New session</Link> puts one on {machine}
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

export function Machine() {
  const { machine: name } = useParams({ from: '/m/$machine' })
  const client = useQueryClient()
  const machines = useMachines()
  const readiness = useMachineReadiness(name)
  const sessions = useSessions()
  const listed = loaded(useWorkspaces())
  const here: Reading<Workspace[]> =
    listed.looked === 'ok'
      ? { ...listed, data: listed.data.filter((one) => one.machine === name) }
      : listed
  const agents = useAgents(here)

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

  const one = machines.looked === 'ok' ? machines.data.find((m) => m.name === name) : undefined
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

  const checks = readiness.looked === 'ok' ? readiness.data.checks : []
  const counted = tally(checks)
  const state = one ? machineState(one) : null
  const rows = agents.looked === 'ok' ? agents.data : []

  return (
    <div className="machine">
      <header className="machine__title">
        <Text as="h1" emphasized scale="display-small">
          {name}
        </Text>
        {state ? (
          <Chip tone={state.state === 'failed' ? 'error' : 'lowest'}>
            <Mark size="small" state={state.state} />
            {state.word}
          </Chip>
        ) : null}
        <Looked className="machine__looked" reads={[machines, readiness, sessions]} />
        <span className="machine__spacer" />
        <Doctor machine={name} variant="outlined" />
        <Button render={<Link to="/new" />} role="link" variant="tonal">
          New session
        </Button>
      </header>

      <div className="machine__columns">
        <ErrorBoundary eyebrow={name} title="About could not be drawn">
          <Card aria-labelledby="machine-about" className="machine__card">
            <div className="machine__eyebrow">
              <Eyebrow as="h2" id="machine-about">
                About
              </Eyebrow>
            </div>
            {one ? (
              <About machine={one} />
            ) : (
              <div aria-busy="true" className="machine__pending">
                <Skeleton shape="text" style={{ width: '56%' }} />
                <Skeleton shape="text" style={{ width: '72%' }} />
              </div>
            )}
          </Card>
        </ErrorBoundary>

        <ErrorBoundary eyebrow={name} title="Readiness could not be drawn">
          <Card aria-labelledby="machine-readiness" className="machine__card">
            <div className="machine__eyebrow">
              <Eyebrow as="h2" id="machine-readiness">
                Readiness
              </Eyebrow>
              {readiness.looked === 'ok' ? (
                <Mono>
                  {counted.present} of {counted.total} · asked {readiness.age_seconds}s ago
                </Mono>
              ) : null}
            </div>
            {readiness.looked === 'failed' ? (
              <ErrorSurface.Inline
                error={fromReading(readiness)!}
                reset={() => void client.invalidateQueries()}
                title="The checks could not be read"
              />
            ) : readiness.looked === 'ok' ? (
              <ul className="machine__checks">
                {checks.map((check) => (
                  <li className="machine__check" key={check.check}>
                    <State size="small" state={markOf(check.state)}>
                      {check.check}
                    </State>
                    <Text className="machine__word" scale="label-small">
                      {wordOf(check.state)}
                    </Text>
                    <Text className="machine__detail m3-clip" scale="body-small" tone="variant">
                      {check.detail}
                    </Text>
                  </li>
                ))}
              </ul>
            ) : (
              <div aria-busy="true" className="machine__pending">
                <Skeleton shape="text" style={{ width: '64%' }} />
                <Skeleton shape="text" style={{ width: '52%' }} />
              </div>
            )}
            <Text as="p" className="machine__note" scale="body-small" tone="variant">
              Read, not run: the sweep asked this machine. Doctor asks it again now, one ssh round
              trip.
            </Text>
          </Card>
        </ErrorBoundary>

        <ErrorBoundary eyebrow={name} title="The workspaces could not be drawn">
          <Workspaces machine={name} pending={agents.looked === 'pending'} rows={rows} />
        </ErrorBoundary>

        <ErrorBoundary eyebrow={name} title="The sessions could not be drawn">
          <Sessions machine={name} sessions={sessions} workspaces={here} />
        </ErrorBoundary>
      </div>
    </div>
  )
}
