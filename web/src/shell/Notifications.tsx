import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Bell as BellIcon, GitPullRequest, Radio } from 'lucide-react'
import { ago } from '@/lib/time'
import { Badge } from '@/m3/badge/Badge'
import { Button } from '@/m3/button/Button'
import { IconButton, type IconButtonProps } from '@/m3/icon-button/IconButton'
import { Row, RowText } from '@/m3/row/Row'
import { Segment, Segmented } from '@/m3/segmented/Segmented'
import { Eyebrow, Mono } from '@/m3/text/Text'
import { IconTile, Tile } from '@/m3/tile/Tile'
import { useTick } from '@/useTick'
import { grouped, type Entry } from './notifications'
import { writePrefs } from './prefs'
import { useEntries } from './useEntries'
import './Notifications.css'

export function Bell(props: Omit<IconButtonProps, 'label' | 'badge' | 'children'>) {
  const { badge } = useEntries()
  return (
    <IconButton
      badge={badge > 0 ? <Badge count={badge} label={`${badge} unread`} /> : undefined}
      label="Notifications"
      variant="tonal"
      {...props}
    >
      <BellIcon />
    </IconButton>
  )
}

function EntryTile(props: { tile: Entry['tile'] }) {
  const { tile } = props
  if (tile.kind === 'workspace') return <Tile name={tile.name} />
  if (tile.kind === 'machine') return <Tile name={tile.name} />
  return <IconTile>{tile.kind === 'github' ? <GitPullRequest /> : <Radio />}</IconTile>
}

function EntryRow(props: { entry: Entry; now: number; onOpen: () => void }) {
  const { entry, now, onOpen } = props
  return (
    <li>
      <Row
        render={entry.href ? <a href={entry.href} rel="noreferrer" target="_blank" /> : undefined}
        tone="lowest"
      >
        <EntryTile tile={entry.tile} />
        <RowText headline={entry.headline} supporting={entry.supporting} />
        {entry.answer ? (
          <Button
            onClick={onOpen}
            role="link"
            render={<Link params={{ name: entry.answer }} search={{ view: 'chat' }} to="/w/$name" />}
            size="s"
          >
            Answer
          </Button>
        ) : null}
        <Mono className="notifications__age">{ago(now / 1000 - entry.at, now).text}</Mono>
      </Row>
    </li>
  )
}

/** The list itself: the popover's, the side sheet's and the phone screen's
 *  one body. `onOpen` closes whatever holds it when a row navigates. */
export function NotificationsList(props: { onOpen?: () => void }) {
  const { onOpen } = props
  const { entries, fresh } = useEntries()
  const [filter, setFilter] = useState<'unread' | 'all'>('unread')
  const now = useTick(true)
  const shown = grouped(filter === 'unread' ? fresh : entries, now)
  const newest = entries[0]?.at ?? null

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
            <Eyebrow as="h3" className="notifications__label">
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
        {/* Nothing on the wire reads the relay back yet (inventory §C), so
            this never says push is on. */}
        <span>Push to phone is not set up</span>
        <Link params={{ category: 'notifications' }} to="/settings/$category">
          Settings
        </Link>
      </p>
    </div>
  )
}

