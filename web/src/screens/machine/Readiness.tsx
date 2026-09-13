import { useEffect, useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Check, Event, Readiness as Report } from '@/api'
import { fromReading, type Reading } from '@/api/client'
import { asApiError } from '@/api/errors'
import { useAbout } from '@/api/hooks'
import { useInstall, useRecheckReadiness } from '@/api/mutations'
import { fixOf, nameOf } from '@/lib/checks'
import { ago } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Copyable } from '@/m3/copyable/Copyable'
import { Disclosure } from '@/m3/disclosure/Disclosure'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { type MarkState, State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Snackbar } from '@/m3/snackbar/Snackbar'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { Track } from '@/m3/track/Track'
import { Doctor } from '@/screens/machines/Doctor'
import { tally, wordOf } from '@/screens/machines/facts'
import { joinCommand, joinUrl } from '@/screens/setup/steps'
import { useTick } from '@/useTick'
import { answer, LOST_MS, newestInstall } from './install'
import type { Verdicted } from './useVerdict'
import { sorted, startable, titleOf, type Verdict } from './verdict'
import './Readiness.css'

/** D7 §3.3: a missing check is something to do, not a failure. */
const marks: Record<Check['state'], MarkState> = { present: 'done', absent: 'needs', unknown: 'unknown' }

function CheckLine(props: { check: Check; machine: string }) {
  const { check, machine } = props
  const fix = check.state === 'absent' ? fixOf(check.check, machine) : null
  return (
    <li className="machine__check">
      <State size="small" state={marks[check.state]}>
        {nameOf(check.check)}
      </State>
      <Text className="machine__word" scale="label-small">
        {wordOf(check.state)}
      </Text>
      <Text className="machine__detail" scale="body-small" tone="variant">
        {check.detail}
      </Text>
      {fix?.by === 'command' ? (
        <div className="machine__fix">
          <Text scale="body-small" tone="variant">
            {fix.where === 'appliance' ? 'Run this on the appliance:' : `Run this on ${machine}:`}
          </Text>
          <Copyable text={fix.command} what={`the command that fixes ${nameOf(check.check)}`} />
        </div>
      ) : fix?.by === 'hand' ? (
        <Text className="machine__fix" scale="body-small" tone="variant">
          {fix.words}
        </Text>
      ) : null}
    </li>
  )
}

function Checks(props: { checks: Check[]; machine: string }) {
  return (
    <ul className="machine__checks">
      {sorted(props.checks).map((check) => (
        <CheckLine check={check} key={check.check} machine={props.machine} />
      ))}
    </ul>
  )
}

function Commands(props: { result: Event; machine: string }) {
  const { result, machine } = props
  if (result.commands.length === 0) return null
  return (
    <div className="readiness__left">
      <Text render={<p />} scale="label-large">
        {result.commands.length === 1 ? 'Left for you to run' : 'Left for you to run, in order'} on {machine}
      </Text>
      <ul className="readiness__commands">
        {result.commands.map((command) => (
          <li key={command}>
            <Copyable text={command} what={`the command for ${machine}`} />
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
  const install = useInstall()
  const recheck = useRecheckReadiness()
  const about = useAbout()
  const running = verdict.kind === 'installing'
  const now = useTick(running)
  const fresh = watch ? answer(events, name, watch) : null
  const [dismissed, setDismissed] = useState<number | null>(null)

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
    const waiting = () => setWatch({ since, pressed: Date.now() })
    install.mutate(name, {
      onSuccess: waiting,
      // One is running already, and its result is the one to wait for.
      onError: (error) => {
        if (error.status === 409) waiting()
      },
    })
  }

  const checks = readiness.looked === 'ok' ? readiness.data.checks : []
  const counted = tally(checks)
  const lost = running && watch !== null && now - watch.pressed > LOST_MS
  const already = install.error?.status === 409
  const refused = install.error && !already ? install.error : null
  const join = joinUrl(location, about.data)
  const corner = !['asleep', 'expired', 'unasked', 'installing', 'pending'].includes(verdict.kind)

  return (
    <Card aria-labelledby={eyebrow} className="machine__card readiness" data-verdict={verdict.kind}>
      <div className="readiness__head">
        <div className="readiness__titles">
          <Eyebrow id={eyebrow}>Readiness</Eyebrow>
          {/* Polite: the verdict changes on its own when an install lands. */}
          <Text aria-live="polite" render={<h2 />} className="readiness__title" emphasized scale="title-large">
            {titleOf(verdict, name)}
          </Text>
          {readiness.looked === 'ok' && checks.length > 0 && verdict.kind !== 'asleep' ? (
            <Mono className="readiness__count">
              {counted.present} of {counted.total} · asked {readiness.age_seconds}s ago
            </Mono>
          ) : null}
        </div>
        {corner ? <Doctor machine={name} /> : null}
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
            sudo on {name} asks for a password, so Yantra stopped before the package step. Run this on {name}, then
            Install again for anything still missing.
          </Text>
          <Commands machine={name} result={verdict.result} />
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
          <Commands machine={name} result={verdict.result} />
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
        {verdict.kind === 'missing' || verdict.kind === 'sudo' ? (
          <Button
            // Until the first read, the newest result is unknown, and an older
            // one would be taken for this press's answer.
            disabled={install.isPending || notifications.isPending}
            onClick={press}
            variant={verdict.kind === 'sudo' ? 'tonal' : 'filled'}
          >
            {install.isPending ? 'Starting…' : verdict.kind === 'sudo' || verdict.result ? 'Install again' : 'Install'}
          </Button>
        ) : null}
        {verdict.kind === 'unasked' ? <Doctor machine={name} variant="tonal" /> : null}
        {verdict.kind === 'ready' || verdict.kind === 'manual' ? (
          <Button render={<Link to="/new" />} role="link" variant={verdict.kind === 'ready' ? 'filled' : 'tonal'}>
            New session
          </Button>
        ) : null}
      </div>

      {cheer !== null ? (
        <Snackbar className="readiness__snackbar" onClose={() => setDismissed(cheer)}>
          {name} is ready for sessions
        </Snackbar>
      ) : null}
    </Card>
  )
}

/** D7 §4.3: the ten, folded to one line. The count is already under the title. */
function folded(checks: Check[]): string {
  const names = checks.map((one) => nameOf(one.check))
  return names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ')
}

function Body(props: {
  verdict: Verdict
  name: string
  checks: Check[]
  readiness: Reading<Report>
  lastSeen: string | null
  join: string | null
  retry: () => void
}) {
  const { verdict, name, checks, readiness, lastSeen, join, retry } = props
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
          {lastSeen ? `Last seen ${lastSeen} ago · ` : ''}Yantra asks again when it comes back.
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
          Yantra has not asked {name} what it has yet. Check again asks it now, one ssh round trip.
        </Text>
      )
    case 'unread':
      return <ErrorSurface.Inline error={fromReading(readiness)!} reset={retry} title="The checks could not be read" />
    case 'refused':
      return (
        <div className="readiness__left">
          <Mono className="readiness__detail">{verdict.detail}</Mono>
          <Text render={<p />} scale="body-small" tone="variant">
            {name} did not take the appliance’s key. Run the join command on {name}; it places the key.
          </Text>
          {join ? <Copyable text={joinCommand(join)} what="the join command" /> : null}
        </div>
      )
    case 'ready':
      return (
        <Disclosure summary={folded(checks)}>
          <Checks checks={checks} machine={name} />
        </Disclosure>
      )
    case 'unreachable':
      return (
        <>
          <Mono className="readiness__detail">{verdict.detail}</Mono>
          <Checks checks={checks} machine={name} />
        </>
      )
    default:
      return <Checks checks={checks} machine={name} />
  }
}
