import { Link } from '@tanstack/react-router'
import type { Check, Machine } from '@/api'
import { at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Chip } from '@/m3/chip/Chip'
import { Mark, State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { Ago } from '@/screens/fleet/age'
import { Doctor } from './Doctor'
import { CARD_CHECKS, checkNamed, machineState, markOf, summary, tally, wordOf } from './facts'

/** `os` is a family rather than a distribution (api.ts), and the beat carries
 *  the architecture — so the line says what the daemon knows and no more. */
function About(props: { machine: Machine }) {
  const { machine } = props
  const beat = machine.heartbeat
  return (
    <Text as="p" className="machines__about" scale="body-small" tone="variant">
      {machine.os}
      {beat ? ` · ${beat.arch}` : ''}
      {machine.address ? (
        <>
          {' · '}
          <Mono>{machine.address}</Mono>
        </>
      ) : null}
      {beat ? (
        <>
          {' · beat '}
          <Ago seconds={beat.age_seconds} /> ago
        </>
      ) : (
        ' · no beat has arrived'
      )}
    </Text>
  )
}

function CheckLine(props: { check: Check }) {
  const { check } = props
  return (
    <li className="machines__check">
      <State size="small" state={markOf(check.state)}>
        {check.check}
      </State>
      <Text className="machines__word" scale="label-small">
        {wordOf(check.state)}
      </Text>
      <Text className="machines__detail m3-wrap" scale="body-small" tone="variant">
        {check.detail}
      </Text>
    </li>
  )
}

export type MachineCardProps = {
  machine: Machine
  checks: Check[]
  /** The phone board condenses a card that passes: the failing checks are
   *  named and the rest are one line. */
  condensed: boolean
  pending: boolean
}

export function MachineCard(props: MachineCardProps) {
  const { machine, checks, condensed, pending } = props
  const { state, word } = machineState(machine)
  const four = CARD_CHECKS.flatMap((name) => {
    const check = checkNamed(checks, name)
    return check ? [check] : []
  })
  const counted = tally(four)
  const shown = condensed ? four.filter((one) => one.state !== 'present') : four
  // D3 §5.7's one clock, as the board prints it: `2h` under a day, `7 Jul` past one.
  const seen = machine.last_seen ? at(machine.last_seen) : null

  return (
    <Card aria-labelledby={`machine-${machine.name}`} className="machines__card">
      <div className="machines__head">
        <Text as="h2" emphasized id={`machine-${machine.name}`} scale="title-large">
          {machine.name}
        </Text>
        <Chip tone={state === 'failed' ? 'error' : 'lowest'}>
          <Mark size="small" state={state} />
          {word}
          {machine.online || !seen ? null : (
            <Mono className="machines__since">
              <time dateTime={seen.iso} title={seen.title}>
                {seen.text}
              </time>
            </Mono>
          )}
        </Chip>
      </div>

      <About machine={machine} />

      {pending ? (
        <div aria-busy="true" className="machines__pending">
          <Skeleton shape="text" style={{ width: '70%' }} />
          <Skeleton shape="text" style={{ width: '54%' }} />
        </div>
      ) : (
        <>
          <ul className="machines__checks">
            {shown.map((check) => (
              <CheckLine check={check} key={check.check} />
            ))}
          </ul>
          <Text className="machines__summary" scale="body-small" tone="variant">
            {summary(counted)}
          </Text>
        </>
      )}

      <div className="machines__actions">
        <Button
          render={<Link params={{ machine: machine.name }} to="/m/$machine" />}
          role="link"
          variant="tonal"
        >
          Open
        </Button>
        {counted.present < counted.total ? <Doctor machine={machine.name} /> : null}
      </div>
    </Card>
  )
}
