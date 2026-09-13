import { useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { GitPullRequest, Laptop, Radio } from 'lucide-react'
import { asApiError } from '@/api/errors'
import { useAbout, useNotifications } from '@/api/hooks'
import { ago } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Copyable } from '@/m3/copyable/Copyable'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State } from '@/m3/mark/Mark'
import { Row, RowText } from '@/m3/row/Row'
import { Segment, Segmented } from '@/m3/segmented/Segmented'
import { Eyebrow, Mono } from '@/m3/text/Text'
import { IconTile, Tile } from '@/m3/tile/Tile'
import { useTick } from '@/useTick'
import { grouped, type Entry } from './notifications'
import { writePrefs } from './prefs'
import { useEntries } from './useEntries'
import './Notifications.css'

function EntryTile(props: { tile: Entry['tile'] }) {
  const { tile } = props
  if (tile.kind === 'workspace') return <Tile name={tile.name} />
  // A machine never looks like a workspace: no letter avatar (S7).
  if (tile.kind === 'machine') return <IconTile><Laptop /></IconTile>
  return <IconTile>{tile.kind === 'github' ? <GitPullRequest /> : <Radio />}</IconTile>
}

/** `RowText` always clips (finding S7): a warning that must stay whole uses
 *  the shared `.m3-wrap` utility on plain spans instead. */
function EntryText(props: { entry: Entry; supporting: ReactNode }) {
  const { entry, supporting } = props
  if (!entry.wrap) return <RowText headline={entry.headline} supporting={supporting} />
  return (
    <div className="m3-row__text">
      <span className="m3-row__headline m3-wrap">{entry.headline}</span>
      <span className="m3-row__supporting m3-wrap">{supporting}</span>
    </div>
  )
}

function EntryRow(props: { entry: Entry; now: number; onOpen: () => void }) {
  const { entry, now, onOpen } = props
  const commands = entry.commands ?? []
  const supporting = entry.mark ? (
    <State size="small" state={entry.mark}>
      {entry.supporting}
    </State>
  ) : (
    entry.supporting
  )
  return (
    <li>
      <Row render={entry.href ? <a href={entry.href} rel="noreferrer" target="_blank" /> : undefined} tone="lowest">
        <EntryTile tile={entry.tile} />
        <EntryText entry={entry} supporting={supporting} />
        {entry.answer ? (
          <Button
            onClick={onOpen}
            role="link"
            render={<Link params={{ name: entry.answer }} search={{ view: 'chat' }} to="/w/$name" />}
            size="s"
          >
            Answer
          </Button>
        ) : entry.open ? (
          <Button
            onClick={onOpen}
            role="link"
            render={<Link params={{ machine: entry.open }} to="/m/$machine" />}
            size="s"
          >
            Open
          </Button>
        ) : null}
        <Mono className="notifications__age">{ago(now / 1000 - entry.at, now).text}</Mono>
      </Row>
      {commands.length ? (
        <div className="notifications__commands">
          {commands.map((command, index) => (
            <Copyable
              key={command}
              text={command}
              what={commands.length > 1 ? `command ${index + 1} of ${commands.length}` : 'the command'}
            />
          ))}
        </div>
      ) : null}
    </li>
  )
}

/** The list itself: the popover's, the side sheet's and the phone screen's
 *  one body. `onOpen` closes whatever holds it when a row navigates. */
export function NotificationsList(props: { onOpen?: () => void }) {
  const { onOpen } = props
  const notifications = useNotifications()
  const about = useAbout()
  const { entries, fresh } = useEntries()
  const [filter, setFilter] = useState<'unread' | 'all'>('unread')
  const now = useTick(true)
  const shown = grouped(filter === 'unread' ? fresh : entries, now)
  const newest = entries[0]?.at ?? null

  if (notifications.error) {
    return (
      <ErrorSurface.Inline
        error={asApiError(notifications.error)}
        reset={() => void notifications.refetch()}
        title="Notifications could not be read"
      />
    )
  }

  return (
    <div className="notifications">
      <div className="notifications__bar">
        <Segmented label="Show" onValueChange={(value) => setFilter(value as 'unread' | 'all')} value={filter}>
          <Segment value="unread">
            Unread{fresh.length ? <Mono className="notifications__count">{fresh.length}</Mono> : null}
          </Segment>
          <Segment value="all">All</Segment>
        </Segmented>
        <Button
          disabled={newest === null || fresh.length === 0}
          onClick={() => writePrefs({ seenAt: newest })}
          variant="text"
        >
          Mark all read
        </Button>
      </div>
      {shown.today.length + shown.earlier.length === 0 ? (
        <p className="notifications__empty">
          {filter === 'unread' ? 'Nothing unread.' : 'Nothing has happened since the daemon started.'}
        </p>
      ) : null}
      {(['today', 'earlier'] as const).map((when) =>
        shown[when].length ? (
          <section aria-label={when === 'today' ? 'Today' : 'Earlier'} key={when}>
            <Eyebrow render={<h3 />} className="notifications__label">
              {when === 'today' ? 'Today' : 'Earlier'}
            </Eyebrow>
            <ul className="notifications__list">
              {shown[when].map((entry) => (
                <EntryRow entry={entry} key={entry.id} now={now} onOpen={() => onOpen?.()} />
              ))}
            </ul>
          </section>
        ) : null,
      )}
      <p className="notifications__foot">
        <span>
          {about.data
            ? about.data.relay
              ? 'Push to your phone is on'
              : 'Push to your phone is off'
            : 'Push to your phone is unknown'}
        </span>
        <Link params={{ category: 'notifications' }} to="/settings/$category">
          Settings
        </Link>
      </p>
    </div>
  )
}

