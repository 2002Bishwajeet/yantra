import { useId, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import type { Room as RoomData, RoomMessage } from '@/api'
import { asApiError } from '@/api/errors'
import { usePostToRoom, useResumeRoom } from '@/api/mutations'
import { roomQuery } from '@/api/queries'
import * as Composer from '@/composer/Composer'
import { useEnterSends } from '@/composer/enterSends'
import { PrimaryAction } from '@/composer/PrimaryAction'
import { ago } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { announce } from '@/m3/live/live'
import { Page } from '@/m3/page/Page'
import { PageHeader } from '@/m3/page/PageHeader'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { useTick } from '@/useTick'
import { facts } from './facts'
import './Rooms.css'

function Message({ message, now }: { message: RoomMessage; now: number }) {
  const when = ago(now / 1000 - message.at, now)
  return (
    <li className="room__message">
      <div className="room__meta">
        <span className="room__from">{message.from}</span>
        <time className="room__time" dateTime={when.iso} title={when.title}>
          {when.text}
        </time>
      </div>
      {/* Plain text: an agent wrote it, so it is never markup. */}
      <p className="room__text">{message.text}</p>
    </li>
  )
}

function Paused({ name, budget }: { name: string; budget: number }) {
  const resume = useResumeRoom()
  return (
    <Card className="room__paused" surface="high">
      <EmptyState
        compact
        action={
          <Button
            aria-busy={resume.isPending || undefined}
            className="room__resume"
            onClick={() =>
              resume.mutate(name, { onSuccess: () => announce(`Room ${name} resumed.`) })
            }
          >
            {resume.isPending ? 'Resuming…' : 'Resume'}
          </Button>
        }
        state="needs"
        title="Paused"
      >
        The agents sent {budget} messages, so the room waits for you. Resume it, or post a message.
      </EmptyState>
      {resume.error ? (
        <ErrorSurface.Inline error={resume.error} title="The room was not resumed" />
      ) : null}
    </Card>
  )
}

function Compose({ name }: { name: string }) {
  const [text, setText] = useState('')
  const post = usePostToRoom()
  const enterSends = useEnterSends()
  const id = useId()
  const submit = () => {
    if (post.isPending || text.trim() === '') return
    post.mutate(
      { name, text },
      {
        onSuccess: (sent) => {
          setText('')
          announce(`Posted to ${name}. ${sent.delivered} ${sent.delivered === 1 ? 'member sees' : 'members see'} it.`)
        },
      },
    )
  }
  return (
    <div className="room__compose">
      <Composer.Root
        aria-labelledby={`${id}-title`}
        empty={text === ''}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          submit()
        }}
      >
        <h2 className="m3-sr-only" id={`${id}-title`}>
          Post to {name}
        </h2>
        <Composer.Input
          aria-describedby={`${id}-hint`}
          aria-label="Message"
          enterSends={enterSends}
          onChange={(event) => setText(event.target.value)}
          onSend={submit}
          placeholder="Every agent in the room reads it"
          value={text}
        />
        <span className="m3-sr-only" id={`${id}-hint`}>
          Every agent in the room reads it. Posting sets the count back to 0.
        </span>
        <Composer.Footer
          actions={
            <PrimaryAction
              label="Post"
              pending={post.isPending}
              reason={post.isPending ? 'Posting…' : text.trim() === '' ? 'Type a message to post it.' : null}
            />
          }
        />
      </Composer.Root>
      {post.error ? <ErrorSurface.Inline error={post.error} title="The message was not posted" /> : null}
    </div>
  )
}

function Body({ room }: { room: RoomData }) {
  const now = useTick(true)
  return (
    <div className="room__body">
      <Mono className="room__facts">{facts(room)}</Mono>
      {room.paused ? <Paused budget={room.budget} name={room.name} /> : null}
      {room.log.length === 0 ? (
        <Text render={<p />} scale="body-medium" tone="variant">
          No messages yet.
        </Text>
      ) : (
        <ol aria-label="Messages" className="room__log">
          {room.log.map((message) => (
            <Message key={message.seq} message={message} now={now} />
          ))}
        </ol>
      )}
      <Compose name={room.name} />
    </div>
  )
}

function Unread({ name, error, reset }: { name: string; error: unknown; reset: () => void }) {
  const said = asApiError(error)
  if (said.kind === 'missing') {
    return (
      <ErrorSurface.Page
        action={
          <Button role="link" render={<Link to="/rooms" />} variant="tonal">
            All rooms
          </Button>
        }
        error={{
          kind: said.kind,
          said: said.said,
          retryable: false,
          describe: () => 'yantrad holds rooms in memory, so a restart clears them.',
        }}
        eyebrow="Rooms"
        title={`No room is called ${name}`}
      />
    )
  }
  return <ErrorSurface.Page eyebrow="Rooms" error={said} reset={reset} title="The room could not be read" />
}

/** `/rooms/$room` (ADR-0038 decision 5): what the agents said, and the two
 *  acts that set the count to 0, a post and a resume. */
export function Room() {
  const { room: name } = useParams({ from: '/rooms/$room' })
  const room = useQuery(roomQuery(name))
  return (
    <Page centered width="reading">
      <PageHeader title={name} />
      {/* A 404 on a later poll is a room the daemon lost, so it wins over what was drawn. */}
      {room.error && (!room.data || asApiError(room.error).kind === 'missing') ? (
        <Unread error={room.error} name={name} reset={() => void room.refetch()} />
      ) : room.data ? (
        <ErrorBoundary layout="card" title="The room could not be drawn">
          <Body room={room.data} />
        </ErrorBoundary>
      ) : (
        <div aria-busy="true" className="rooms__list" data-slot="reading">
          <Skeleton lines={1} shape="card" />
          <Skeleton lines={1} shape="card" />
        </div>
      )}
    </Page>
  )
}
