import { ArrowUpRight, CircleDot, GitPullRequest } from 'lucide-react'
import type { Attention, Item } from '@/api'
import type { Reading } from '@/api/hooks'
import { lacksGrant, QUEUE_WHY, type Grant } from '@/lib/github'
import { at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { State } from '@/m3/mark/Mark'
import { Row } from '@/m3/row/Row'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Num, Text } from '@/m3/text/Text'
import { IconTile } from '@/m3/tile/Tile'
import { useFormFactor } from '@/shell/formFactor'
import { Ago } from './age'
import { KeptReading } from './KeptReading'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { NotConnected } from '@/screens/settings/NotConnected'
import { StartSession } from './StartSession'

/** D6 §3: a block inside `Needs you`, under its own heading, because a
 *  crashed agent on your own fleet is more urgent than a review request. Its
 *  links open GitHub and nothing else. */
export function Github(props: { attention: Reading<Attention>; grant: Grant }) {
  const { attention, grant } = props

  return (
    <section aria-labelledby="fleet-github" className="github">
      <div className="github__head">
        <Text render={<h3 />} emphasized id="fleet-github" scale="title-small">
          On GitHub
        </Text>
        {attention.looked === 'ok' && attention.data.notifications > 0 ? (
          <a className="github__unread m3-hit" href="https://github.com/notifications" rel="noreferrer" target="_blank">
            Open {attention.data.notifications} on GitHub
            <ArrowUpRight aria-hidden="true" />
          </a>
        ) : null}
        {attention.looked === 'ok' && attention.retrying ? (
          <KeptReading className="github__kept" reading={attention} />
        ) : attention.looked === 'ok' || attention.looked === 'failed' ? (
          // On the daemon's 300 s clock, so the block stamps itself (D6 §2).
          <Num className="github__age">
            as of <Ago seconds={attention.age_seconds} /> · read every 5 min
          </Num>
        ) : null}
      </div>

      {attention.looked === 'pending' ? (
        <div aria-busy="true" className="github__pending">
          <Skeleton shape="text" style={{ width: '40%' }} />
          <Skeleton shape="text" style={{ width: '64%' }} />
        </div>
      ) : null}

      {attention.looked === 'never' ? <EmptyState state="unknown" title="GitHub not looked at yet" /> : null}

      {attention.looked === 'failed' ? <Failed error={attention.error} grant={grant} /> : null}

      {attention.looked === 'ok' ? (
        <div className="github__groups">
          <Group items={attention.data.reviews} title="Reviews" verb="Review" why="review requested" />
          <Group items={attention.data.issues} title="Issues" verb="Open" why="assigned issue" />
        </div>
      ) : null}
    </section>
  )
}

/** Y-753: a missing or refused grant is one row with a Connect button, read from the daemon's
 *  connection and not from its words. Any other reason is shown as said, with its backticked
 *  commands drawn as code. */
function Failed(props: { error: string; grant: Grant }) {
  const { error, grant } = props
  if (lacksGrant(grant)) {
    return <NotConnected refused={grant.kind === 'refused'} why={QUEUE_WHY} />
  }
  return (
    <div className="github__failed" role="status">
      <State state="failed">GitHub could not be read</State>
      <Text render={<p />} className="github__error" scale="body-medium">
        <Said text={error} />
      </Text>
    </div>
  )
}

function Said(props: { text: string }) {
  return props.text.split('`').map((part, n) =>
    n % 2 ? (
      <code className="github__code m3-mono" key={n}>
        {part}
      </code>
    ) : (
      part
    ),
  )
}

/** Two lists rather than one with a badge: which list an item is in is its
 *  kind, and a badge would re-encode what the heading already says. Reviews
 *  come first because a review blocks someone else. */
function Group(props: { items: Item[]; title: string; verb: string; why: string }) {
  const { items, title, verb, why } = props
  const factor = useFormFactor()
  if (items.length === 0) return null
  const Icon = verb === 'Review' ? GitPullRequest : CircleDot
  return (
    <div className="github__group">
      <div className="github__label">
        <Text render={<h4 />} scale="body-small" tone="variant">
          {title}
        </Text>
        <Num className="github__count">{items.length}</Num>
      </div>
      <ul className="github__list">
        {items.map((item) => {
          const clock = at(item.updated_at)
          const ref = factor === 'phone' ? item.repo.split('/').pop() : item.repo
          return (
            <li className="github__item" key={item.url}>
              <Row className="github__row">
                <IconTile className="github__tile">
                  <Icon />
                </IconTile>
                <div className="github__text">
                  <span className="github__meta">
                    <Mono className="github__ref">
                      {ref}#{item.number}
                    </Mono>
                    <span className="github__why">{why}</span>
                    {/* GitHub's age, which is the item's rather than the answer's. */}
                    <Num className="github__when">{clock?.text ?? item.updated_at}</Num>
                  </span>
                  <span className="github__title">{item.title}</span>
                </div>
                <div className="github__actions">
                  <Button render={<a href={item.url} rel="noreferrer" target="_blank" />} role="link" variant="outlined">
                    {verb}
                  </Button>
                  {verb === 'Open' ? <StartSession item={item} /> : null}
                </div>
              </Row>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
