import { type ReactNode, useEffect, useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Check, Event, Readiness as Report } from '@/api'
import { fromReading, type Reading } from '@/api/client'
import { asApiError } from '@/api/errors'
import { useAbout } from '@/api/hooks'
import { useInstall, useRecheckReadiness } from '@/api/mutations'
import { causeOf, fixOf, isNightly, nameOf, olderAgent, tookOf, withoutMarkdown, withoutSignIn } from '@/lib/checks'
import { ago, seen } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Copyable } from '@/m3/copyable/Copyable'
import { Disclosure } from '@/m3/disclosure/Disclosure'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Snackbar } from '@/m3/snackbar/Snackbar'
import { Eyebrow, Text } from '@/m3/text/Text'
import { Track } from '@/m3/track/Track'
import { Doctor } from '@/screens/machines/Doctor'
import { counted, optionalAbsent, rowMark, rowWord, tally } from '@/screens/machines/facts'
import { joinUrl } from '@/lib/join'
import { useTick } from '@/useTick'
import { answer, LOST_MS, needsSudo, newestInstall } from './install'
import { ReachFailure } from './ReachFailure'
import { type Step, SudoSheet } from './SudoSheet'
import type { Verdicted } from './useVerdict'
import { sorted, startable, titleOf, type Verdict } from './verdict'
import './Readiness.css'

function CheckLine(props: { check: Check; machine: string; fix?: boolean; nightlyMac?: boolean }) {
  const { check, machine } = props
  const showFix = props.fix ?? true
  const fix = showFix && check.state === 'absent' ? fixOf(check, machine) : null
  const line = (
    <div className="machine__line">
      <State size="small" state={rowMark(check)}>
        {nameOf(check.check)}
      </State>
      <Text className="machine__word" scale="label-small">
        {rowWord(check)}
      </Text>
      <Text className="machine__cause" scale="body-small" tone="variant">
        {causeOf(check)}
      </Text>
    </div>
  )
  if (!fix) return <li className="machine__check">{line}</li>
  const where =
    fix.by !== 'command'
      ? null
      : olderAgent(check) && props.nightlyMac
        ? 'Nightly has no Mac build; this installs the latest stable.'
        : fix.where === 'appliance'
          ? 'Run this on the appliance:'
          : fix.where === 'terminal'
            ? `Open Terminal on ${machine} and run:`
            : `Run this on ${machine}:`
  // An older agent's words only repeat the command in the fix.
  const said = check.detail && !olderAgent(check) && !optionalAbsent(check) ? withoutMarkdown(withoutSignIn(check.detail)) : null
  return (
    <li className="machine__check">
      <Disclosure action="Fix" className="machine__fixrow" summary={line}>
        <div className="machine__fix">
          <Text scale="body-small" tone="variant">
            {fix.by === 'hand' ? fix.words : where}
          </Text>
          {fix.by === 'command' ? <Copyable line text={fix.command} what={`the command that fixes ${nameOf(check.check)}`} /> : null}
          {said ? (
            <Text className="m3-wrap" render={<div />} scale="body-small">
              {said}
            </Text>
          ) : null}
          {check.took_ms === undefined ? null : (
            <Text className="machine__detail" scale="body-small" tone="variant">
              {tookOf(check.took_ms)}
            </Text>
          )}
        </div>
      </Disclosure>
    </li>
  )
}

function Checks(props: { checks: Check[]; machine: string; fix?: boolean; nightlyMac?: boolean }) {
  return (
    <ul className="machine__checks">
      {sorted(props.checks).map((check) => (
        <CheckLine check={check} fix={props.fix} key={check.check} machine={props.machine} nightlyMac={props.nightlyMac} />
      ))}
    </ul>
  )
}

/** Y-676: the words of the probes that failed, one press away. A probe that passed has nothing to say.
 *  An older agent's versions are in its row, and its heartbeat never came over ssh (Y-713). */
function ProbeSaid(props: { checks: Check[] }) {
  const said = props.checks.filter((one) => one.state !== 'present' && one.detail && !optionalAbsent(one) && !olderAgent(one))
  if (said.length === 0) return null
  return (
    <Disclosure summary="What ssh said">
      {said.map((one) => (
        <Text className="m3-wrap" key={one.check} render={<div />} scale="body-small">
          {nameOf(one.check)}: {withoutSignIn(one.detail)}
        </Text>
      ))}
    </Disclosure>
  )
}

/** ADR-0031 §9: the microphone is optional, so it waits behind a closed row. A Mac never offers it, so it gets no row. */
function Optional(props: { checks: Check[]; machine: string; fix: boolean; action: ReactNode }) {
  const optional = props.checks.filter(optionalAbsent)
  if (optional.length === 0 || !props.fix) return null
  return (
    <Disclosure summary="Optional: microphone">
      <Checks checks={optional} fix={props.fix} machine={props.machine} />
      {props.action ? <div className="readiness__actions">{props.action}</div> : null}
    </Disclosure>
  )
}

/** Each command left for a person, with Copy. A step sudo stopped also
 *  opens in a terminal of its own (Y-394); `emphasis` is filled where that is
 *  the card's one next thing. */
function Commands(props: {
  result: Event
  machine: string
  onTerminal: (step: Step) => void
  emphasis: 'filled' | 'tonal'
}) {
  const { result, machine, onTerminal, emphasis } = props
  if (result.commands.length === 0) return null
  const firstSudo = result.commands.findIndex(needsSudo)
  return (
    <div className="readiness__left">
      <Text render={<p />} scale="label-large">
        {result.commands.length === 1 ? 'Left for you to run' : 'Left for you to run, in order'} on {machine}
      </Text>
      <ul className="readiness__commands">
        {result.commands.map((command, index) => (
          <li className="readiness__command" key={command}>
            <Copyable line text={command} what={`the command for ${machine}`} />
            {needsSudo(command) ? (
              <Button data-sudo-opener="" onClick={() => onTerminal({ index, command, at: result.at })} variant={index === firstSudo ? emphasis : 'tonal'}>
                Open a terminal
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** D7 §4.3: the verdict is the title, and it decides the card's one filled
 *  action. Y-396: Install runs `POST …/install`, which answers 202, and the
 *  result is the next `installed` or `install_stopped` event for this
 *  machine; readiness is then asked again, once, because a person pressed
 *  (ADR-0019). */
export function ReadinessCard(props: {
  name: string
  readiness: Reading<Report>
  lastSeen: string | null
  state: Verdicted
}) {
  const { name, readiness, lastSeen, state } = props
  const { verdict, events, watch, setWatch, notifications } = state
  const eyebrow = useId()
  const heading = useId()
  const install = useInstall()
  const recheck = useRecheckReadiness()
  const about = useAbout()
  const running = verdict.kind === 'installing'
  const now = useTick(running)
  const fresh = watch ? answer(events, name, watch) : null
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [step, setStep] = useState<Step | null>(null)
  const [mic, setMic] = useState(false)
  const micId = useId()

  const answered = fresh?.at
  const { mutate: ask } = recheck
  useEffect(() => {
    if (answered !== undefined) ask(name)
  }, [answered, name, ask])

  const cheer = fresh?.kind === 'installed' && startable(verdict) && dismissed !== fresh.at ? fresh.at : null
  useEffect(() => {
    if (cheer === null) return
    const timer = setTimeout(() => setDismissed(cheer), 6_000)
    return () => clearTimeout(timer)
  }, [cheer])

  const press = () => {
    const since = newestInstall(events, name)?.at ?? 0
    const asked = offerMic && mic
    const waiting = () => setWatch({ since, pressed: Date.now(), mic: asked })
    install.mutate({ machine: name, mic: asked }, {
      onSuccess: waiting,
      // One is running already, and its result is the one to wait for.
      onError: (error) => {
        if (error.status === 409) waiting()
      },
    })
  }

  const checks = readiness.looked === 'ok' ? readiness.data.checks : []
  // ADR-0031 §1: the microphone is Install's one optional item, offered until
  // doctor finds it. A Mac has no PipeWire, so it is never offered there.
  const offerMic = state.os !== 'macOS' && checks.some((one) => one.check === 'mic' && one.state !== 'present')
  const installable = verdict.kind === 'missing' || verdict.kind === 'sudo' || (startable(verdict) && offerMic)
  // On a startable machine the microphone is all Install could do.
  const nothingAsked = startable(verdict) && !mic
  const tallied = tally(checks)
  const lost = running && watch !== null && now - watch.pressed > LOST_MS
  const already = install.error?.status === 409
  const refused = install.error && !already ? install.error : null
  const join = joinUrl(location, about.data)
  const nightlyMac = state.os === 'macOS' && isNightly(about.data?.version)
  // One filled action: New session when a session can start, else Check again on a manual machine.
  const sessionFirst = verdict.kind === 'ready' || (verdict.kind === 'manual' && verdict.ready)
  const checkFirst = verdict.kind === 'manual' && !verdict.ready
  // The microphone is optional: on a machine that can start sessions its fix waits inside the closed Optional row.
  const inside = startable(verdict) && offerMic
  const micBox = (
    <label className="readiness__mic" htmlFor={micId}>
            <input checked={mic} id={micId} onChange={(event) => setMic(event.target.checked)} type="checkbox" />
            <Text scale="label-large">Microphone</Text>
          </label>
  )
  const installButton = (
    <Button
            // Until the first read, the newest result is unknown, and an older
            // one would be taken for this press's answer.
            disabled={install.isPending || notifications.isPending || nothingAsked}
            onClick={press}
            variant={verdict.kind === 'missing' ? 'filled' : 'tonal'}
          >
            {install.isPending
              ? 'Starting…'
              : verdict.kind === 'sudo' || (verdict.kind === 'missing' && verdict.result)
                ? 'Install again'
                : 'Install'}
          </Button>
  )
  const corner = !['asleep', 'expired', 'unasked', 'installing', 'pending'].includes(verdict.kind)

  return (
    <Card aria-labelledby={eyebrow} className="machine__card readiness" data-verdict={verdict.kind}>
      <div className="readiness__head">
        <div className="readiness__titles">
          <Eyebrow id={eyebrow}>Readiness</Eyebrow>
          {/* Polite: the verdict changes on its own when an install lands. */}
          <Text
            aria-live="polite"
            className="readiness__title"
            emphasized
            id={heading}
            render={<h2 />}
            scale="title-large"
            tabIndex={-1}
          >
            {titleOf(verdict, name)}
          </Text>
          {readiness.looked === 'ok' && checks.length > 0 && verdict.kind !== 'asleep' ? (
            <Text className="readiness__count" scale="body-small" tone="variant">
              {counted(tallied)} · asked {readiness.age_seconds}s ago
            </Text>
          ) : null}
        </div>
        {corner ? (
          <Doctor machine={name} variant={checkFirst ? 'filled' : undefined} />
        ) : null}
      </div>

      {running ? (
        <div className="readiness__running">
          <Track label={`Installing on ${name}`} />
          <p className="readiness__line" role="status">
            {lost ? (
              <State size="small" state="unknown">
                No result arrived. A daemon restart empties the events, so Check again asks {name} what it has now.
              </State>
            ) : (
              <State size="small" state="running">
                {already ? `An install was already running on ${name}. ` : ''}
                {watch ? `Started ${ago((now - watch.pressed) / 1000, now).text} ago. ` : ''}
                Running in the background; the result also arrives in Notifications.
              </State>
            )}
          </p>
        </div>
      ) : null}

      {verdict.kind === 'sudo' ? (
        <>
          <Text render={<p />} className="readiness__said" scale="body-small" tone="variant">
            sudo on {name} wants a password; run this there.
          </Text>
          <Commands emphasis="filled" machine={name} onTerminal={setStep} result={verdict.result} />
        </>
      ) : null}

      {verdict.kind === 'missing' && verdict.result ? (
        <div className="readiness__result">
          <p className="readiness__line">
            <State size="small" state={verdict.result.kind === 'installed' ? 'done' : 'needs'}>
              {verdict.result.kind === 'installed' ? 'The last install finished' : 'The install stopped'}
              {verdict.fresh ? '' : ` · the last install, ${ago(now / 1000 - verdict.result.at, now).text} ago`}
            </State>
          </p>
          <Text render={<p />} className="readiness__said" scale="body-small" tone="variant">
            {verdict.result.said}
          </Text>
          <Commands emphasis="tonal" machine={name} onTerminal={setStep} result={verdict.result} />
        </div>
      ) : null}

      {verdict.kind === 'missing' && !verdict.result ? (
        <Text render={<p />} className="readiness__said" scale="body-small" tone="variant">
          Yantra installs only what is missing, with {name}’s own package manager and the vendor’s installer for claude.
          Root is sudo without a password; a step that needs more is left for you to run.
        </Text>
      ) : null}

      {/* After the result: the command left for a person is the next thing,
          and ten check lines above it would push it off a phone's screen. */}
      <Body
        checks={checks}
        join={join}
        lastSeen={lastSeen}
        micFix={state.os !== 'macOS'}
        nightlyMac={nightlyMac}
        micAction={inside ? <>{micBox}{installButton}</> : null}
        name={name}
        readiness={readiness}
        retry={() => ask(name)}
        verdict={verdict}
      />

      {notifications.error && running ? (
        <ErrorSurface.Inline
          error={asApiError(notifications.error)}
          reset={() => void notifications.refetch()}
          title="The result could not be read"
        />
      ) : null}
      {refused ? <ErrorSurface.Inline error={refused} reset={press} title="Install did not start" /> : null}
      {recheck.error ? (
        <ErrorSurface.Inline error={recheck.error} reset={() => ask(name)} title="Readiness could not be asked again" />
      ) : null}

      <div className="readiness__actions">
        {lost ? (
          <Button onClick={() => setWatch(null)} variant="text">
            Stop waiting
          </Button>
        ) : null}
        {inside ? null : (
          <>
            {installable && offerMic ? micBox : null}
            {installable ? installButton : null}
          </>
        )}
        {verdict.kind === 'unasked' ? <Doctor first machine={name} variant="tonal" /> : null}
        {verdict.kind === 'ready' || verdict.kind === 'manual' ? (
          <Button render={<Link to="/new" />} role="link" variant={sessionFirst ? 'filled' : 'tonal'}>
            New session
          </Button>
        ) : null}
      </div>

      {/* The command ended: what is missing now is readiness's to say. */}
      <SudoSheet
        fallback={heading}
        machine={name}
        onClose={() => setStep(null)}
        onDone={() => {
          setWatch(null)
          ask(name)
        }}
        step={step}
      />

      {cheer !== null ? (
        <Snackbar className="readiness__snackbar" onClose={() => setDismissed(cheer)}>
          {name} is ready for sessions
        </Snackbar>
      ) : null}
    </Card>
  )
}

function Body(props: {
  verdict: Verdict
  name: string
  checks: Check[]
  readiness: Reading<Report>
  lastSeen: string | null
  join: string | null
  micFix: boolean
  nightlyMac: boolean
  micAction: ReactNode
  retry: () => void
}) {
  const { verdict, name, checks, readiness, lastSeen, join, micFix, nightlyMac, micAction, retry } = props
  const failing = checks.filter((one) => one.state !== 'present')
  switch (verdict.kind) {
    case 'pending':
      return (
        <div aria-busy="true" className="machine__pending">
          <Skeleton shape="text" style={{ width: '64%' }} />
          <Skeleton shape="text" style={{ width: '52%' }} />
        </div>
      )
    case 'asleep':
      return (
        <Text render={<p />} className="readiness__said" scale="body-medium" tone="variant">
          {lastSeen ? `Last seen ${seen(lastSeen)} · ` : ''}Yantra asks again when it comes back.
        </Text>
      )
    case 'expired':
      return (
        <Text render={<p />} className="readiness__said" scale="body-medium" tone="variant">
          Tailscale stopped trusting {name} until someone logs in to Tailscale on it again.
        </Text>
      )
    case 'unasked':
      return (
        <Text render={<p />} className="readiness__said" scale="body-medium" tone="variant">
          Check asks {name} what it has now, one ssh round trip.
        </Text>
      )
    case 'unread':
      return <ErrorSurface.Inline error={fromReading(readiness)!} reset={retry} title="The checks could not be read" />
    case 'refused':
    case 'unjoined':
    case 'browser':
    case 'changed':
    case 'unreachable':
      return (
        <ReachFailure detail={verdict.detail} join={join} kind={verdict.kind} name={name}>
          {failing.length > 0 ? <Checks checks={failing} machine={name} nightlyMac={nightlyMac} /> : null}
        </ReachFailure>
      )
    case 'ready':
      return (
        <>
          <Optional action={micAction} checks={checks} fix={micFix} machine={name} />
          <ProbeSaid checks={checks} />
        </>
      )
    default: {
      const first = sorted(checks).find((one) => one.state === 'absent' && !optionalAbsent(one))
      const rest = checks.filter((one) => one !== first && one.state !== 'present' && !optionalAbsent(one))
      return (
        <>
          {first ? <Checks checks={[first]} machine={name} nightlyMac={nightlyMac} /> : null}
          {rest.length > 0 ? <Checks checks={rest} fix={false} machine={name} /> : null}
          <Optional action={micAction} checks={checks} fix={micFix} machine={name} />
          <ProbeSaid checks={checks} />
        </>
      )
    }
  }
}
