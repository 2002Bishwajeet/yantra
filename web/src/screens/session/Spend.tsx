import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import type { Counts, Spend as Read, Workspace } from '@/api'
import { type Asked, refusal } from '@/lib/spend'
import { at, on } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Chip } from '@/m3/chip/Chip'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Mark, State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { count, money } from './format'

// The four token fields, and never `responses` — a response is not a token.
const tokens = (of: Counts) => of.input + of.output + of.cache_write + of.cache_read

const responses = (of: number) => `${count(of)} response${of === 1 ? '' : 's'}`

/** The headline, and the three refusals to price that `render_tokens` makes:
 *  nothing spent, fast mode, and any model the table does not carry (D5
 *  §6.2). Where any model is unpriced the headline is the token count and no
 *  dollar figure is drawn — a partly-priced sum is the understatement R-23
 *  refuses. */
function Hero(props: { spend: Read }) {
  const { spend } = props
  const unpriced = spend.models.some((model) => model.cost === null)
  const asOf = on(spend.as_of)
  const nothing = spend.total.responses === 0
  return (
    <Card className="spend__hero" surface="primary">
      <div className="spend__headline">
        <div>
          <Eyebrow>This session</Eyebrow>
          <div className="spend__figure">
            {nothing ? (
              <Text scale="display-small" emphasized>
                nothing spent
              </Text>
            ) : spend.cost === null || unpriced ? (
              <>
                <Mono className="spend__number">{count(tokens(spend.total))}</Mono>
                <Text scale="title-medium">tokens, unpriced</Text>
              </>
            ) : (
              <>
                <Mono className="spend__number">{money(spend.cost)}</Mono>
                <Text scale="title-medium">
                  across {spend.models.length} model{spend.models.length === 1 ? '' : 's'}
                </Text>
              </>
            )}
          </div>
        </div>
        {/* `as_of` is the day a written-down table was read, not an instant. */}
        <Text scale="body-small">
          prices as of <Mono>{asOf ? asOf.text : spend.as_of}</Mono>
        </Text>
      </div>
      {!nothing && (spend.cost === null || unpriced) ? (
        <Text as="p" scale="body-medium">
          {spend.fast > 0
            ? `${responses(spend.fast)} ran in fast mode, which is billed at a rate this price table does not carry. Fast mode withholds dollars: this session shows tokens and no money.`
            : 'Not every model below is priced, so there is no figure to give.'}
        </Text>
      ) : null}
      <div className="spend__counts">
        <Eyebrow>Counts</Eyebrow>
        <dl className="spend__grid">
          {(
            [
              ['responses', spend.total.responses],
              ['input', spend.total.input],
              ['output', spend.total.output],
              ['cache write', spend.total.cache_write],
              ['cache read', spend.total.cache_read],
            ] as const
          ).map(([label, value]) => (
            <div className="spend__count" key={label}>
              <dt>{label}</dt>
              <dd>
                <Mono>{count(value)}</Mono>
              </dd>
            </div>
          ))}
        </dl>
        <Text as="p" scale="body-small">
          Four counts, never summed: they are not the same unit of anything. Money is the one figure that
          adds them.
        </Text>
      </div>
    </Card>
  )
}

function Figure(props: { spend: Read }) {
  const { spend } = props
  return (
    <>
      <Hero spend={spend} />
      {spend.models.length > 0 ? (
        <ul className="spend__models">
          {spend.models.map((model) => (
            <li key={model.model}>
              <Card className="spend__model">
                <div className="spend__model-head">
                  <Mono clip>{model.model}</Mono>
                  <Chip icon={<Mark size="small" state={model.cost === null ? 'unknown' : 'needs'} />}>
                    {model.cost === null ? 'unpriced' : 'priced'}
                  </Chip>
                </div>
                <div className="spend__model-figure">
                  <Mono className="spend__model-cost">{model.cost === null ? '—' : money(model.cost)}</Mono>
                  <Text scale="body-small" tone="variant">
                    <Mono>{count(model.responses)}</Mono> response{model.responses === 1 ? '' : 's'}
                  </Text>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <Text as="p" scale="body-medium" tone="variant">
          no model wrote a response in this transcript
        </Text>
      )}
      <Card as="div" className="spend__fast" surface="lowest">
        <State state={spend.fast > 0 ? 'needs' : 'idle'}>
          <Text scale="title-medium">Fast mode</Text>
        </State>
        <Text scale="body-small" tone="variant">
          <Mono>{count(spend.fast)}</Mono> responses ran at fast mode's rate. Above zero, every cost here is
          null and this card shows tokens and no money.
        </Text>
      </Card>
      {/* A path is long and a phone is 390 px wide, so it clips rather than
          pushing the page sideways. */}
      <Text as="p" className="spend__path" scale="body-small" tone="variant">
        transcript <Mono clip>{spend.path}</Mono>
      </Text>
    </>
  )
}

export type SpendProps = {
  workspace: Workspace
  asked: Asked
  now: number
  onAsk: () => void
}

/** `/w/{name}`'s spend tab: `/usage`'s answer with the picker removed (D5
 *  §6.1). Mounting it is the request; the pill reads again. */
export function Spend(props: SpendProps) {
  const { workspace, asked, now, onAsk } = props

  useEffect(() => {
    if (asked.asked === 'no') onAsk()
  }, [asked.asked, onAsk])

  const read = asked.asked === 'read' ? at(asked.at, now) : null
  const machine = (
    <Link params={{ machine: workspace.machine }} to="/m/$machine">
      {workspace.machine}
    </Link>
  )

  return (
    <div className="spend">
      <div className="spend__ask">
        <Button disabled={asked.asked === 'asking'} icon={<RefreshCw />} onClick={onAsk}>
          Read spend
        </Button>
        <Text as="p" scale="body-small" tone="variant">
          Reads the agent's transcript on {machine} over ssh, when you ask. Nothing polls it.
          {read ? (
            <>
              {' '}
              Read{' '}
              <Mono>
                <time dateTime={read.iso} title={read.title}>
                  {read.text}
                </time>
              </Mono>{' '}
              ago.
            </>
          ) : null}
        </Text>
      </div>
      <div aria-live="polite" className="spend__answer">
        {asked.asked === 'asking' || asked.asked === 'no' ? (
          <div aria-busy="true" className="turns__reading" data-slot="reading">
            <Skeleton shape="text" />
            <Skeleton shape="text" />
            <Text as="p" scale="body-small" tone="variant">
              reading the transcript on {workspace.machine} over ssh
            </Text>
          </div>
        ) : null}
        {asked.asked === 'nothing' ? (
          <Card surface="high">
            <Text as="h3" scale="title-medium">
              There is nothing to add up yet.
            </Text>
            <Text as="p" scale="body-medium" tone="variant">
              No agent in this workspace has written a turn. A fresh one has not started, and one waiting
              at claude's trust prompt never gets that far.
            </Text>
            <Mono className="turns__said">{asked.said}</Mono>
          </Card>
        ) : null}
        {asked.asked === 'refused' ? (
          <ErrorSurface.Inline
            action={
              <Button role="link" render={<Link params={{ machine: workspace.machine }} to="/m/$machine" />} variant="text">
                {workspace.machine}
              </Button>
            }
            error={{ kind: 'refused', said: asked.said, retryable: true, describe: () => refusal(asked.status) }}
            eyebrow={`on ${workspace.machine}`}
            reset={onAsk}
            title="The spend could not be read"
          />
        ) : null}
        {asked.asked === 'read' ? <Figure spend={asked.spend} /> : null}
      </div>
      <Text as="p" scale="body-small" tone="variant">
        Per workspace only. There is no fleet total: one would cost an ssh transcript read per workspace
        on open.
      </Text>
    </div>
  )
}
