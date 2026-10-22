import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { fromReading } from '@/api/client'
import { Button } from '@/m3/button/Button'
import { loaded, useMachines, useReadiness, useSessions, useWorkspaces } from '@/api/hooks'
import { apart, notYours, runsSessions } from '@/lib/platform'
import { Card } from '@/m3/card/Card'
import { Chip } from '@/m3/chip/Chip'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { List, ListItem } from '@/m3/list/List'
import { Page } from '@/m3/page/Page'
import { PageHeader } from '@/m3/page/PageHeader'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Eyebrow } from '@/m3/text/Text'
import { useFormFactor } from '@/shell/formFactor'
import { useFab } from '@/shell/primary'
import { unreachable } from '@/work'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { Looked } from '@/screens/fleet/age'
import { checksOf, unclaimed } from './facts'
import { MachineCard } from './MachineCard'
import { Unclaimed } from './Unclaimed'
import './Machines.css'

function Waiting() {
  return (
    <ul className="machines__grid">
      {[0, 1, 2].map((one) => (
        <li key={one}>
          <Card aria-busy="true" className="machines__card">
            <Skeleton shape="text" style={{ width: '48%' }} />
            <Skeleton shape="text" style={{ width: '72%' }} />
            <Skeleton shape="row" />
          </Card>
        </li>
      ))}
    </ul>
  )
}

export function Machines() {
  const client = useQueryClient()
  const machines = useMachines()
  const readiness = useReadiness()
  const sessions = useSessions()
  const workspaces = loaded(useWorkspaces())
  const factor = useFormFactor()
  // D7 §4.4: on the phone and the tablet the FAB carries Add a device.
  const fab = useFab()

  const nothing = unreachable([machines, readiness, sessions])
  if (nothing) {
    return (
      <Page>
        <PageHeader title="Machines" />
        <ErrorSurface.Page
          error={fromReading(machines)!}
          eyebrow="Machines read"
          reset={() => void client.invalidateQueries()}
          title="Nothing here can be reached"
          unknowns={['off the tailnet', 'yantrad down']}
        />
      </Page>
    )
  }

  const list = machines.looked === 'ok' ? machines.data : []
  // D7 §3.4: a phone, a tablet and a Windows PC open the dashboard; they
  // never get a card, a check or a count.
  const runs = list.filter(runsSessions)
  const devices = list.filter((one) => one.ownership === 'yours' && !runsSessions(one))
  // Y-404: listed with the reason, never counted.
  const foreign = list.filter((one) => one.ownership !== 'yours')
  const checks = readiness.looked === 'ok' ? readiness.data : []
  const held =
    sessions.looked === 'ok' && workspaces.looked === 'ok'
      ? unclaimed(sessions.data, workspaces.data)
      : []

  return (
    <Page>
      <PageHeader
        actions={
          fab ? null : (
            <Button icon={<Plus />} render={<Link to="/machines/add" />} role="link" variant="tonal">
              Add a device
            </Button>
          )
        }
        stamp={<Looked reads={[machines, readiness, sessions]} />}
        title="Machines"
      />

      <ErrorBoundary eyebrow="Machines" title="The machines could not be drawn">
        {machines.looked === 'failed' ? (
          <ErrorSurface.Card
            error={fromReading(machines)!}
            eyebrow="Machines"
            reset={() => void client.invalidateQueries()}
            title="The machines could not be read"
          />
        ) : machines.looked === 'ok' ? (
          runs.length > 0 ? (
            <ul className="machines__grid">
              {runs.map((machine) => (
                <li key={machine.name}>
                  <MachineCard
                    checks={checksOf(checks, machine.name)}
                    condensed={factor === 'phone'}
                    machine={machine}
                    pending={readiness.looked === 'pending'}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <Card>
              <EmptyState title="No machine can run a session yet">
                <Link to="/machines/add">Add a device</Link>
              </EmptyState>
            </Card>
          )
        ) : (
          <Waiting />
        )}
      </ErrorBoundary>

      {machines.looked === 'ok' && devices.length > 0 ? (
        <ErrorBoundary eyebrow="Devices" title="The devices could not be drawn">
          <Card aria-labelledby="machines-devices">
            <Eyebrow id="machines-devices" render={<h2 />}>
              Devices that open the dashboard
            </Eyebrow>
            <List>
              {devices.map((device) => (
                <ListItem
                  headline={device.name}
                  key={device.name}
                  supporting={apart(device)}
                  trailing={device.os === 'windows' ? <Chip>coming soon</Chip> : null}
                />
              ))}
            </List>
          </Card>
        </ErrorBoundary>
      ) : null}

      {machines.looked === 'ok' && foreign.length > 0 ? (
        <ErrorBoundary eyebrow="Another account" title="The other account's devices could not be drawn">
          <Card aria-labelledby="machines-foreign">
            <Eyebrow id="machines-foreign" render={<h2 />}>
              Devices your account does not own
            </Eyebrow>
            <List>
              {foreign.map((device) => (
                <ListItem
                  headline={device.name}
                  key={device.name}
                  supporting={notYours(device)}
                  trailing={<Chip>{device.ownership}</Chip>}
                />
              ))}
            </List>
          </Card>
        </ErrorBoundary>
      ) : null}

      <ErrorBoundary eyebrow="Worth a look" title="The sessions could not be drawn">
        <Unclaimed
          held={held}
          pending={sessions.looked === 'pending' || workspaces.looked === 'pending'}
        />
      </ErrorBoundary>
    </Page>
  )
}
