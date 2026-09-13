import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Check, Machine } from '@/api'
import { useAbout, useNotifications } from '@/api/hooks'
import { useInstall, useRecheckReadiness } from '@/api/mutations'
import { nameOf } from '@/lib/checks'
import { joinCommand, joinUrl } from '@/lib/join'
import { at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Chip } from '@/m3/chip/Chip'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Mark, State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { Ago } from '@/screens/fleet/age'
import { isAge } from '@/screens/fleet/clock'
import { answer, newestInstall, type Watch } from '@/screens/machine/install'
import { asEvents } from '@/shell/notifications'
import { Doctor } from './Doctor'
import { CARD_CHECKS, cardChip, cardVerdict, checkNamed, markOf, summary, tally, wordOf } from './facts'

/** `os` is a family rather than a distribution (api.ts), and the beat carries
 *  the architecture — so the line says what the daemon knows and no more. */
function About(props: { machine: Machine }) {
  const { machine } = props
  const beat = machine.heartbeat
  return (
    <Text render={<p />} className="machines__about" scale="body-small" tone="variant">
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
          <Ago seconds={beat.age_seconds} />
          {isAge(beat.age_seconds) ? ' ago' : null}
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
        {nameOf(check.check)}
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

/** D7 §4.4: a basic is missing, and Install (`yantra install`) can fix it.
 *  Watches for the result the way the machine page's Readiness card does
 *  (`Watch`, `answer`, `newestInstall` from `screens/machine/install`), so a
 *  press here shows running and asks readiness again once it lands, rather
 *  than a second watch of its own. */
function Install(props: { machine: string }) {
  const { machine } = props
  const notifications = useNotifications()
  const events = asEvents(notifications.data)
  const install = useInstall()
  const recheck = useRecheckReadiness()
  const [watch, setWatch] = useState<Watch | null>(null)
  const fresh = watch ? answer(events, machine, watch) : null
  const running = watch !== null && !fresh

  const answered = fresh?.at
  const { mutate: ask } = recheck
  useEffect(() => {
    if (answered !== undefined) ask(machine)
  }, [answered, machine, ask])

  const press = () => {
    const since = newestInstall(events, machine)?.at ?? 0
    const waiting = () => setWatch({ since, pressed: Date.now() })
    install.mutate(machine, {
      onSuccess: waiting,
      // One is running already, and its result is the one to wait for.
      onError: (error) => {
        if (error.status === 409) waiting()
      },
    })
  }

  const already = install.error?.status === 409
  const refused = install.error && !already ? install.error : null

  return (
    <>
      <Button disabled={install.isPending || running} onClick={press} variant="tonal">
        {running ? 'Installing…' : 'Install'}
      </Button>
      {refused ? (
        <ErrorSurface.Inline className="machines__said" error={refused} reset={press} title="Install did not start" />
      ) : null}
    </>
  )
}

/** D7 §4.4: the key was refused, and the join command places a fresh one. */
function CopyJoin() {
  const about = useAbout()
  const [said, setSaid] = useState<'idle' | 'copied' | 'failed'>('idle')
  const url = joinUrl(location, about.data)
  const copy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(joinCommand(url))
      setSaid('copied')
    } catch {
      setSaid('failed')
    }
  }
  return (
    <>
      <Button disabled={!url} onClick={copy} variant="tonal">
        {said === 'copied' ? 'Copied' : 'Copy join command'}
      </Button>
      {said === 'failed' ? (
        <Text className="machines__said" scale="body-small" tone="variant">
          This page has no clipboard. Open the machine to copy it there.
        </Text>
      ) : null}
    </>
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
  const four = CARD_CHECKS.flatMap((name) => {
    const check = checkNamed(checks, name)
    return check ? [check] : []
  })
  const counted = tally(four)
  const shown = condensed ? four.filter((one) => one.state !== 'present') : four
  // D3 §5.7's one clock, as the board prints it: `2h` under a day, `7 Jul` past one.
  const seen = machine.last_seen ? at(machine.last_seen) : null
  const verdict = cardVerdict(machine, checks)
  const chip = cardChip(verdict, seen?.text ?? null)

  return (
    <Card aria-labelledby={`machine-${machine.name}`} className="machines__card">
      <div className="machines__head">
        <Text render={<h2 />} emphasized id={`machine-${machine.name}`} scale="title-large">
          {machine.name}
        </Text>
        <Chip tone={chip.error ? 'error' : 'lowest'}>
          <Mark size="small" state={chip.state} />
          {chip.word}
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
        {verdict.kind === 'needs' ? <Install machine={machine.name} /> : null}
        {verdict.kind === 'refused' ? <CopyJoin /> : null}
        {verdict.kind === 'unchecked' ? <Doctor machine={machine.name} /> : null}
      </div>
    </Card>
  )
}
