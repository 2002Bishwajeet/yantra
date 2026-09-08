import { Link } from '@tanstack/react-router'
import { ArrowUpRight, CircleDot, GitPullRequest } from 'lucide-react'
import type { Attention, Item } from '@/api'
import type { Reading } from '@/api/hooks'
import { at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { State } from '@/m3/mark/Mark'
import { Row } from '@/m3/row/Row'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { IconTile } from '@/m3/tile/Tile'
import { useFormFactor } from '@/shell/formFactor'
import { Ago } from './age'
import { Empty } from './Empty'

/** D6 §3.4: the daemon's reasons are already instructions, and the one about
 *  a missing sign-in has a page to send a reader to. */
const GRANTLESS = /grant|logged in|signed in|auth login/i

/** D6 §3: a block inside `Needs you`, under its own heading, because a
 *  crashed agent on your own fleet is more urgent than a review request. Its
 *  links open GitHub and nothing else. */
export function Github(props: { attention: Reading<Attention> }) {
  const { attention } = props
  const factor = useFormFactor()

  return (
    <section aria-labelledby="fleet-github" className="github">
      <div className="github__head">
        <Text as="h3" emphasized id="fleet-github" scale="title-small">
          On GitHub
        </Text>
        {attention.looked === 'ok' && attention.data.notifications > 0 ? (
          <a className="github__unread" href="https://github.com/notifications" rel="noreferrer" target="_blank">
            <Mono>{attention.data.notifications}</Mono>
            {factor === 'phone' ? 'notifications' : 'notifications on GitHub'}
            <ArrowUpRight aria-hidden="true" />
          </a>
        ) : null}
        {attention.looked === 'ok' || attention.looked === 'failed' ? (
          // On the daemon's 300 s clock, so the block stamps itself (D6 §2).
          <Mono className="github__age">
            as of <Ago seconds={attention.age_seconds} /> · read every 5 min
          </Mono>
        ) : null}
      </div>

      {attention.looked === 'pending' ? (
        <div aria-busy="true" className="github__pending">
          <Skeleton shape="text" style={{ width: '40%' }} />
          <Skeleton shape="text" style={{ width: '64%' }} />
        </div>
      ) : null}

      {attention.looked === 'never' ? <Empty state="unknown" title="GitHub not looked at yet" /> : null}

      {attention.looked === 'failed' ? (
        <div className="github__failed" role="status">
          <State state="failed">GitHub cannot be asked</State>
          <Mono className="github__error">{attention.error}</Mono>
          {GRANTLESS.test(attention.error) ? (
            <Button render={<Link params={{ category: 'providers' }} to="/settings/$category" />} role="link" variant="text">
              Sign in
            </Button>
          ) : null}
        </div>
      ) : null}

      {attention.looked === 'ok' ? (
        <div className="github__groups">
          <Group items={attention.data.reviews} title="Reviews" verb="Review" />
          <Group items={attention.data.issues} title="Issues" verb="Open" />
        </div>
      ) : null}
    </section>
  )
}

/** Two lists rather than one with a badge: which list an item is in is its
 *  kind, and a badge would re-encode what the heading already says. */
function Group(props: { items: Item[]; title: string; verb: string }) {
  const { items, title, verb } = props
  const factor = useFormFactor()
  if (items.length === 0) return null
  const Icon = verb === 'Review' ? GitPullRequest : CircleDot
  return (
    <div className="github__group">
      <div className="github__label">
        <Text as="h4" scale="body-small" tone="variant">
          {title}
        </Text>
        <Mono className="github__count">{items.length}</Mono>
      </div>
      <ul className="github__list">
        {items.map((item) => {
          const clock = at(item.updated_at)
          const ref = factor === 'phone' ? item.repo.split('/').pop() : item.repo
          return (
            <li key={item.url}>
              <Row className="github__row" render={<a href={item.url} rel="noreferrer" target="_blank" />}>
                <IconTile className="github__tile">
                  <Icon />
                </IconTile>
                <span className="github__text">
                  <Mono className="github__ref m3-wrap">
                    {ref}#{item.number}
                  </Mono>
                  <span className="github__title m3-wrap">{item.title}</span>
                </span>
                {/* GitHub's age, which is the item's rather than the answer's. */}
                <Mono className="github__when">{clock?.text ?? item.updated_at}</Mono>
                <span className="github__verb">{verb}</span>
              </Row>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
