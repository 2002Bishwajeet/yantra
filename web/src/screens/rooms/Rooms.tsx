import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { RoomSummary } from '@/api'
import { asApiError } from '@/api/errors'
import { roomsQuery } from '@/api/queries'
import { Card } from '@/m3/card/Card'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State } from '@/m3/mark/Mark'
import { Page } from '@/m3/page/Page'
import { PageHeader } from '@/m3/page/PageHeader'
import { Row, RowText } from '@/m3/row/Row'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { facts } from './facts'
import './Rooms.css'

function List({ rooms }: { rooms: RoomSummary[] }) {
  if (rooms.length === 0) {
    return (
      <Card className="rooms__empty">
        <EmptyState title="No rooms">
          A room starts when an agent calls room_send or room_read. yantrad holds rooms in memory,
          so a restart clears them.
        </EmptyState>
      </Card>
    )
  }
  return (
    <ul className="rooms__list">
      {rooms.map((room) => (
        <li key={room.name}>
          <Row className="rooms__row" render={<Link params={{ room: room.name }} to="/rooms/$room" />}>
            <RowText headline={room.name} supporting={facts(room)} />
            {room.paused ? (
              <State className="rooms__state" state="needs">
                paused
              </State>
            ) : null}
          </Row>
        </li>
      ))}
    </ul>
  )
}

/** `/rooms` (ADR-0038 decision 4): the rooms live agents share, and which of
 *  them wait for the owner. */
export function Rooms() {
  const rooms = useQuery(roomsQuery())
  return (
    <Page>
      <PageHeader title="Rooms" />
      {rooms.data ? (
        <ErrorBoundary layout="card" title="The rooms could not be drawn">
          <List rooms={rooms.data} />
        </ErrorBoundary>
      ) : rooms.error ? (
        <ErrorSurface.Page
          eyebrow="Rooms read"
          error={asApiError(rooms.error)}
          reset={() => void rooms.refetch()}
          title="The rooms could not be read"
        />
      ) : (
        <div aria-busy="true" className="rooms__list" data-slot="reading">
          <Skeleton shape="row" />
          <Skeleton shape="row" />
        </div>
      )}
    </Page>
  )
}
