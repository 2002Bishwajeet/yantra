import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Check, Machine } from '@/api'
import { useAbout, useNotifications } from '@/api/hooks'
import { useInstall, useRecheckReadiness } from '@/api/mutations'
import { causeOf, nameOf, olderAgent, reachableFailure, reachWords } from '@/lib/checks'
import { stripControls } from '@/lib/controls'
import { joinCommand, joinUrl } from '@/lib/join'
import { at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Chip } from '@/m3/chip/Chip'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Mark, State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Text } from '@/m3/text/Text'
import { answer, newestInstall, type Watch } from '@/screens/machine/install'
import { chipOf, verdictOf } from '@/screens/machine/verdict'
import { SshSaid } from '@/screens/machine/ReachFailure'
import { asEvents } from '@/shell/notifications'
import { Doctor } from './Doctor'
import { CARD_CHECKS, checkNamed, factsOf, markOf, rowWord, summary, tally } from './facts'

/** `pressable` is false on a machine that is off: D7 §3.3 gives that card
 *  nothing to press, and its machine page holds the raw text. */
function CheckLine(props: { check: Check; pressable: boolean }) {
  const { check, pressable } = props
  const failed = check.check === 'reachable' && check.state === 'absent'
  return (
    <li className="machines__check">
      {/* An agent that reports but is older needs an update, not a red failure (Y-740). */}
      <State size="small" state={olderAgent(check) ? 'needs' : markOf(check.state)}>
        {nameOf(check.check)}
      </State>
      <Text className="machines__word" scale="label-small">
        {rowWord(check)}
      </Text>
      <Text className="machines__detail" scale="body-small" tone="variant">
        {causeOf(check)}
      </Text>
      {failed && pressable ? <SshSaid detail={check.detail} /> : null}
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
    const waiting = () => setWatch({ since, pressed: Date.now(), mic: false })
    install.mutate({ machine }, {
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
      await navigator.clipboard.writeText(stripControls(joinCommand(url)))
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
  pending: boolean
  /** Tmux sessions the machine reported; null when it did not answer. */
  sessions: number | null
}

export function MachineCard(props: MachineCardProps) {
  const { machine, checks, pending, sessions } = props
  const four = CARD_CHECKS.flatMap((name) => {
    const check = checkNamed(checks, name)
    return check ? [check] : []
  })
  // ADR-0046: not one of the four, so its warning is a line of its own. Unknown is not absent (R-23).
  const sudo = checkNamed(checks, 'no-sudo')
  // D3 §5.7's one clock, as the board prints it: `2h` under a day, `7 Jul` past one.
  const seen = machine.last_seen ? at(machine.last_seen) : null
  const verdict = verdictOf({
    name: machine.name,
    machine,
    readiness: { looked: 'ok', age_seconds: 0, data: { machine: machine.name, checks, age_seconds: 0 } },
    events: [],
    watch: null,
  })
  // Y-714: a card names what needs the owner and counts the rest. A ready machine
  // with gaps lists those gaps, which are not always among the four.
  const shown = verdict.kind === 'manual' ? verdict.absent.filter((one) => one.check !== 'no-sudo') : four.filter((one) => one.state !== 'present')
  const chip = chipOf(verdict, seen?.text ?? null)
  // The machine cannot be reached, so a tally of checks nobody could ask says nothing.
  const reachable = checkNamed(checks, 'reachable')
  const reach =
    verdict.kind === 'refused' ||
    verdict.kind === 'unjoined' ||
    verdict.kind === 'browser' ||
    verdict.kind === 'changed' ||
    verdict.kind === 'unreachable'
      ? verdict
      : // An offline machine that ssh also failed to reach has the same one sentence (Y-714).
        verdict.kind === 'asleep' && reachable?.state === 'absent'
        ? { kind: reachableFailure(reachable.detail), detail: reachable.detail }
        : null

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

      <Text render={<p />} className="machines__about" scale="body-small" tone="variant">
        {factsOf(machine, sessions)}
      </Text>
      {machine.control_lost ? (
        <Text render={<p />} className="machines__about" scale="body-small" tone="variant">
          Tailscale lost its control server. The machine still answers over the tailnet.
        </Text>
      ) : null}

      {pending ? (
        <div aria-busy="true" className="machines__pending">
          <Skeleton shape="text" style={{ width: '70%' }} />
          <Skeleton shape="text" style={{ width: '54%' }} />
        </div>
      ) : (
        <>
          {reach ? (
            <>
              <Text render={<p />} className="machines__about" scale="body-medium">
                {reachWords(reach.kind, machine.name).cause}
              </Text>
              <SshSaid detail={reach.detail} />
            </>
          ) : (
            <ul className="machines__checks">
              {shown.map((check) => (
                <CheckLine
                  check={check}
                  key={check.check}
                  pressable={verdict.kind !== 'asleep' && verdict.kind !== 'expired'}
                />
              ))}
            </ul>
          )}
          {sudo?.state === 'absent' ? (
            <Text render={<p role="note" />} className="machines__about" scale="body-small" tone="error">
              Agents here can use sudo
            </Text>
          ) : null}
          {verdict.kind === 'unasked' || reach ? null : (
            <Text className="machines__summary" scale="body-small" tone="variant">
              {summary(tally(checks))}
            </Text>
          )}
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
        {verdict.kind === 'missing' || verdict.kind === 'sudo' ? <Install machine={machine.name} /> : null}
        {verdict.kind === 'refused' || verdict.kind === 'unjoined' || verdict.kind === 'browser' ? <CopyJoin /> : null}
        {verdict.kind === 'unasked' ? <Doctor first machine={machine.name} /> : null}
      </div>
    </Card>
  )
}
