import { useQueryClient } from '@tanstack/react-query'
import { fromReading } from '@/api/client'
import { loaded, useMachines, useReadiness, useSessions, useWorkspaces } from '@/api/hooks'
import { Card } from '@/m3/card/Card'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Text } from '@/m3/text/Text'
import { useFormFactor } from '@/shell/formFactor'
import { unreachable } from '@/work'
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
            <Skeleton />
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

  const nothing = unreachable([machines, readiness, sessions])
  if (nothing) {
    return (
      <ErrorSurface.Page
        error={fromReading(machines)!}
        eyebrow="Machines"
        reset={() => void client.invalidateQueries()}
        title="Nothing here can be reached"
        unknowns={['off the tailnet', 'yantrad down']}
      />
    )
  }

  const list = machines.looked === 'ok' ? machines.data : []
  const checks = readiness.looked === 'ok' ? readiness.data : []
  const held =
    sessions.looked === 'ok' && workspaces.looked === 'ok'
      ? unclaimed(sessions.data, workspaces.data)
      : []

  return (
    <div className="machines">
      <header className="machines__title">
        <Text as="h1" emphasized scale="display-small">
          Machines
        </Text>
        <Looked className="machines__looked" reads={[machines, readiness, sessions]} />
      </header>

      <ErrorBoundary eyebrow="Machines" title="The machines could not be drawn">
        {machines.looked === 'failed' ? (
          <ErrorSurface.Card
            error={fromReading(machines)!}
            eyebrow="Machines"
            reset={() => void client.invalidateQueries()}
            title="The machines could not be read"
          />
        ) : machines.looked === 'ok' ? (
          <ul className="machines__grid">
            {list.map((machine) => (
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
          <Waiting />
        )}
      </ErrorBoundary>

      <ErrorBoundary eyebrow="Worth a look" title="The sessions could not be drawn">
        <Unclaimed
          held={held}
          pending={sessions.looked === 'pending' || workspaces.looked === 'pending'}
        />
      </ErrorBoundary>
    </div>
  )
}
