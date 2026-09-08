import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { fromReading } from '@/api/client'
import { loaded, useWorkspaces } from '@/api/hooks'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { Track } from '@/m3/track/Track'
import { type FormFactor, useFormFactor } from '@/shell/formFactor'
import { Empty } from '@/screens/fleet/Empty'
import { count, money } from './format'
import { byModel, byWorkspace, type Fanned, lines, type Row, useFleetSpend } from './read'
import { SessionsTable } from './Sessions'
import './Usage.css'

function Waiting() {
  return (
    <div aria-busy="true" className="usage__pending">
      <Skeleton shape="text" style={{ width: '46%' }} />
      <Skeleton />
      <Skeleton style={{ width: '78%' }} />
    </div>
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
      <div className="usage__eyebrow">
        <Eyebrow as="h2" id="usage-workspaces">
          By workspace
        </Eyebrow>
        <Text scale="body-small" tone="variant">
          {spent.length} workspace{spent.length === 1 ? '' : 's'} read
        </Text>
      </div>
      {spent.length === 0 ? (
        <Empty title="Nothing was counted">no workspace answered with a figure</Empty>
      ) : (
        <ul className="usage__rows">
          {spent.map((one) => (
            <li className="usage__row" key={one.name}>
              <div className="usage__line">
                <Tile name={one.name} size="small" />
                <span className="usage__text">
                  <span className="usage__name m3-clip">{one.name}</span>
                  <span className="usage__where m3-clip">
                    {one.machine} · {count(one.responses)} responses
                  </span>
                </span>
                <Mono className="usage__cost">
                  {one.cost === null ? 'unpriced' : money(one.cost)}
                </Mono>
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
      <div className="usage__eyebrow">
        <Eyebrow as="h2" id="usage-models">
          By model
        </Eyebrow>
        <Text scale="body-small" tone="variant">
          {models.length} model{models.length === 1 ? '' : 's'}
        </Text>
      </div>
      {models.length === 0 ? (
        <Empty title="No model was named">a transcript with no response names none</Empty>
      ) : (
        <ul className="usage__rows">
          {models.map((one) => (
            <li className="usage__row" key={one.model}>
              <div className="usage__line">
                <span className="usage__text">
                  <span className="usage__name m3-clip">{one.model}</span>
                  <span className="usage__where">
                    {count(one.responses)} responses · {one.workspaces} workspace
                    {one.workspaces === 1 ? '' : 's'}
                  </span>
                </span>
                <Mono className="usage__cost">
                  {one.cost === null ? 'unpriced' : money(one.cost)}
                </Mono>
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
            {row.workspace.name}
          </State>
          <Mono className="usage__reason m3-clip">{row.said}</Mono>
        </li>
      ))}
    </ul>
  )
}

function Read(props: { fanned: Fanned; factor: FormFactor }) {
  const { fanned, factor } = props
  if (fanned.fanned === 'no') {
    return (
      <Card className="usage__card">
        <Empty state="unknown" title="Nothing read yet">
          each figure costs one ssh round trip, so Read spend asks and nothing polls
        </Empty>
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
  const table = lines(fanned.rows)
  return (
    <>
      <div className="usage__columns">
        <ErrorBoundary eyebrow="Usage" title="By workspace could not be drawn">
          <ByWorkspace rows={fanned.rows} />
        </ErrorBoundary>
        <ErrorBoundary eyebrow="Usage" title="By model could not be drawn">
          <ByModel rows={fanned.rows} />
        </ErrorBoundary>
      </div>
      <ErrorBoundary eyebrow="Usage" title="The sessions table could not be drawn">
        <Card aria-labelledby="usage-sessions" className="usage__card">
          <div className="usage__eyebrow">
            <Eyebrow as="h2" id="usage-sessions">
              Sessions
            </Eyebrow>
            <Text scale="body-small" tone="variant">
              {table.length} read · most expensive first
            </Text>
          </div>
          {table.length === 0 ? (
            <Empty title="No transcript answered">nothing was counted, so the table has no row</Empty>
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
  const { fanned, read } = useFleetSpend(list)

  if (listed.looked === 'failed') {
    return (
      <ErrorSurface.Page
        error={fromReading(listed)!}
        eyebrow="Usage"
        reset={() => void client.invalidateQueries()}
        title="Nothing here can be reached"
        unknowns={['off the tailnet', 'yantrad down']}
      />
    )
  }

  const asOf =
    fanned.fanned === 'done'
      ? fanned.rows.find((row) => row.read === 'ok')?.spend.as_of
      : undefined

  return (
    <div className="usage">
      <div className="usage__title">
        <Text as="h1" emphasized scale="display-small">
          Usage
        </Text>
        {/* Y-354 brings the Today / 7 days / 30 days window; until it lands
            there is one window, and it is what the transcripts hold. */}
        <Mono className="usage__as">as read · every response in each transcript</Mono>
        {asOf ? <Mono className="usage__as">prices from {asOf}</Mono> : null}
        <span className="usage__spacer" />
        {list.length > 0 ? (
          <Button disabled={fanned.fanned === 'reading'} onClick={() => void read()}>
            {fanned.fanned === 'reading'
              ? `reading ${fanned.of}…`
              : fanned.fanned === 'done'
                ? 'Read again'
                : 'Read spend'}
          </Button>
        ) : null}
      </div>

      {workspaces.looked === 'pending' ? (
        <Card className="usage__card">
          <Waiting />
        </Card>
      ) : list.length === 0 ? (
        <Card className="usage__card">
          <Empty title="No spend yet">
            money is read from a workspace's transcript, and <Link to="/new">New session</Link>{' '}
            makes the first one
          </Empty>
        </Card>
      ) : (
        <Read factor={factor} fanned={fanned} />
      )}

      <Text as="p" className="usage__note" scale="body-small" tone="variant">
        Each figure is read from the transcript on the machine that wrote it, over ssh, when you
        ask. Nothing here polls, and there is no fleet total.
      </Text>
    </div>
  )
}
