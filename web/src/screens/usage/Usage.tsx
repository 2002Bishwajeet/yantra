import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { on } from '@/lib/time'
import { isOwnAddress, PROXY_HEADLINE, PROXY_SENTENCE } from '@/api/errors'
import { loaded, useWorkspaces } from '@/api/hooks'
import { daemonCouldNotRead } from '@/work'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Segment, Segmented } from '@/m3/segmented/Segmented'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State } from '@/m3/mark/Mark'
import { Page, PagePending } from '@/m3/page/Page'
import { PageHeader } from '@/m3/page/PageHeader'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Num, Text } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { Track } from '@/m3/track/Track'
import { type FormFactor, useFormFactor } from '@/shell/formFactor'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { count, money } from './format'
import { byModel, byWorkspace, type Fanned, lines, type Row, useFleetSpend } from './read'
import { SessionsTable } from './Sessions'
import { asSpan, SPAN_LABEL, SPANS, type Span } from './span'
import './Usage.css'

const AS_READ: Record<Span, string> = {
  all: 'every response in each transcript',
  today: 'responses since midnight here',
  '7d': 'responses in the last 7 days',
  '30d': 'responses in the last 30 days',
}

function Waiting() {
  return (
    <PagePending>
      <Skeleton shape="text" style={{ width: '46%' }} />
      <Skeleton shape="row" />
      <Skeleton shape="row" style={{ width: '78%' }} />
    </PagePending>
  )
}

/** The boards' proportion bar, drawn against the dearest row and never against
 *  a sum: D6 §5.1 forbids a fleet total, and a share of one would be that
 *  total. Both lists arrive sorted, so the first figure is the most spent. */
function Share(props: { cost: number | null; most: number }) {
  const { cost, most } = props
  if (cost === null || most <= 0) return null
  return (
    <Track
      className="usage__share"
      label={`${money(cost)} of the most spent, ${money(most)}`}
      value={cost / most}
    />
  )
}

function ByWorkspace(props: { rows: Row[] }) {
  const { rows } = props
  const spent = byWorkspace(rows)
  const most = spent[0]?.cost ?? 0
  return (
    <Card aria-labelledby="usage-workspaces" className="usage__card">
      <div className="usage__head">
        <Text render={<h2 />} emphasized id="usage-workspaces" scale="title-large">
          By workspace
        </Text>
        <Text scale="body-small" tone="variant">
          {spent.length} workspace{spent.length === 1 ? '' : 's'} read
        </Text>
      </div>
      {spent.length === 0 ? (
        <EmptyState title="Nothing was counted">no workspace answered with a figure</EmptyState>
      ) : (
        <ul className="usage__rows">
          {spent.map((one) => (
            <li className="usage__row" key={one.name}>
              <div className="usage__line">
                <Tile name={one.name} size="small" />
                <span className="usage__text">
                  <span className="usage__name" title={one.name}>{one.name}</span>
                  <span className="usage__where">
                    {one.machine} · {count(one.responses)} responses
                  </span>
                </span>
                <Num className="usage__cost">
                  {one.cost === null ? 'unpriced' : money(one.cost)}
                </Num>
              </div>
              <Share cost={one.cost} most={most} />
            </li>
          ))}
        </ul>
      )}
      <Refusals rows={rows} />
    </Card>
  )
}

function ByModel(props: { rows: Row[] }) {
  const models = byModel(props.rows)
  const most = models[0]?.cost ?? 0
  return (
    <Card aria-labelledby="usage-models" className="usage__card">
      <div className="usage__head">
        <Text render={<h2 />} emphasized id="usage-models" scale="title-large">
          By model
        </Text>
        <Text scale="body-small" tone="variant">
          {models.length} model{models.length === 1 ? '' : 's'}
        </Text>
      </div>
      {models.length === 0 ? (
        <EmptyState title="No model was named">a transcript with no response names none</EmptyState>
      ) : (
        <ul className="usage__rows">
          {models.map((one) => (
            <li className="usage__row" key={one.model}>
              <div className="usage__line">
                <span className="usage__text">
                  <span className="usage__name" title={one.model}>{one.model}</span>
                  <span className="usage__where">
                    {count(one.responses)} responses · {one.workspaces} workspace
                    {one.workspaces === 1 ? '' : 's'}
                  </span>
                  <span className="usage__where">
                    {count(one.input)} in · {count(one.output)} out · {count(one.cacheRead)} cache
                    read
                  </span>
                </span>
                <Num className="usage__cost">
                  {one.cost === null ? 'unpriced' : money(one.cost)}
                </Num>
              </div>
              <Share cost={one.cost} most={most} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** A workspace that answered something other than a figure, named in place —
 *  a 409 is *nothing to count* and not a failure (D5 §4.5). */
function Refusals(props: { rows: Row[] }) {
  const said = props.rows.filter((row) => row.read !== 'ok')
  if (said.length === 0) return null
  return (
    <ul className="usage__said">
      {said.map((row) => (
        <li key={row.workspace.name}>
          <State size="small" state={row.read === 'nothing' ? 'idle' : 'failed'}>
            <span className="usage__who" title={row.workspace.name}>{row.workspace.name}</span>
          </State>
          <Text scale="body-small" className="usage__reason m3-wrap">{row.said}</Text>
        </li>
      ))}
    </ul>
  )
}

type Refused = Extract<Row, { read: 'refused' }>
const ownAddress = (row: Row): row is Refused => row.read === 'refused' && isOwnAddress(row.status, row.said)

/** Every workspace behind the one proxy gets the same refusal, so it is said once, above the boards. */
function ProxyRefusal(props: { held: Refused[] }) {
  const { held } = props
  const error = {
    kind: 'refused',
    said: held[0]!.said,
    retryable: false,
    headline: PROXY_HEADLINE,
    describe: () => PROXY_SENTENCE,
  }
  return (
    <ErrorSurface.Card
      error={error}
      eyebrow="Usage"
      meta={`${held.length} workspace${held.length === 1 ? '' : 's'} held back`}
      title={PROXY_HEADLINE}
    />
  )
}

function Read(props: { fanned: Fanned; factor: FormFactor; read: () => void }) {
  const { fanned, factor, read } = props
  if (fanned.fanned === 'no') {
    return (
      <Card className="usage__card">
        <EmptyState
          action={<Button onClick={read}>Read spend</Button>}
          state="unknown"
          title="Nothing read yet"
        />
      </Card>
    )
  }
  if (fanned.fanned === 'reading') {
    return (
      <Card className="usage__card">
        <Waiting />
      </Card>
    )
  }
  const held = fanned.rows.filter(ownAddress)
  const rows = fanned.rows.filter((row) => !ownAddress(row))
  const table = lines(rows)
  return (
    <>
      {held.length > 0 ? <ProxyRefusal held={held} /> : null}
      <div className="usage__columns">
        <ErrorBoundary eyebrow="Usage" title="By workspace could not be drawn">
          <ByWorkspace rows={rows} />
        </ErrorBoundary>
        <ErrorBoundary eyebrow="Usage" title="By model could not be drawn">
          <ByModel rows={rows} />
        </ErrorBoundary>
      </div>
      <ErrorBoundary eyebrow="Usage" title="The sessions table could not be drawn">
        <Card aria-labelledby="usage-sessions" className="usage__card">
          <div className="usage__head">
            <Text render={<h2 />} emphasized id="usage-sessions" scale="title-large">
              Sessions
            </Text>
            <Text scale="body-small" tone="variant">
              {table.length} read · most expensive first
            </Text>
          </div>
          {table.length === 0 ? (
            <EmptyState title="No transcript answered">nothing was counted, so the table has no row</EmptyState>
          ) : (
            <SessionsTable data={table} factor={factor} />
          )}
        </Card>
      </ErrorBoundary>
    </>
  )
}

export function Usage() {
  const client = useQueryClient()
  const listed = useWorkspaces()
  const workspaces = loaded(listed)
  const factor = useFormFactor()
  const list = workspaces.looked === 'ok' ? workspaces.data : []
  const span = useSearch({ from: '/usage' }).window ?? 'all'
  const navigate = useNavigate({ from: '/usage' })
  const { fanned, read } = useFleetSpend(list, span)

  if (listed.looked === 'failed') {
    return (
      <Page>
        <PageHeader title="Usage" />
        <ErrorSurface.Page
          error={daemonCouldNotRead(listed.error)}
          eyebrow="Workspaces read"
          reset={() => void client.invalidateQueries()}
          title="The daemon could not read the fleet"
        />
      </Page>
    )
  }

  const stamp =
    fanned.fanned === 'done'
      ? fanned.rows.find((row) => row.read === 'ok')?.spend.as_of
      : undefined
  const asOf = stamp === undefined ? undefined : (on(stamp)?.text ?? stamp)

  return (
    <Page>
      <PageHeader
        actions={
          list.length > 0 ? (
            <>
              <Segmented
                label="Window"
                onValueChange={(value) =>
                  void navigate({ search: { window: asSpan(value) }, replace: true })
                }
                value={span}
              >
                {SPANS.map((one) => (
                  <Segment key={one} value={one}>
                    {SPAN_LABEL[one]}
                  </Segment>
                ))}
              </Segmented>
              {fanned.fanned === 'no' ? null : (
                <Button disabled={fanned.fanned === 'reading'} onClick={() => void read()}>
                  {fanned.fanned === 'reading' ? `reading ${fanned.of}…` : 'Read again'}
                </Button>
              )}
            </>
          ) : null
        }
        stamp={
          <>
            <Num>as read · {AS_READ[span]}</Num>
            {asOf ? <Num> · prices from {asOf}</Num> : null}
          </>
        }
        title="Usage"
      />

      {workspaces.looked === 'pending' ? (
        <Card className="usage__card">
          <Waiting />
        </Card>
      ) : list.length === 0 ? (
        <Card className="usage__card">
          <EmptyState title="No spend yet">
            Money is read from a workspace's transcript, and <Link className="m3-hit" to="/new">New session</Link>{' '}
            makes the first one.
          </EmptyState>
        </Card>
      ) : (
        <Read factor={factor} fanned={fanned} read={() => void read()} />
      )}

      <Text render={<p />} className="usage__note" scale="body-small" tone="variant">
        Read over ssh from each machine's transcript, only when you ask. There is no fleet total.
      </Text>
    </Page>
  )
}
