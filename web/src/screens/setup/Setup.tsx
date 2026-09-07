import { useState, type ReactNode } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Check, Copy, GitBranch, Plus, Radio } from 'lucide-react'
import type { Machine, Readiness } from '@/api'
import { fromReading } from '@/api/client'
import { useAbout, useGithub, useMachines, useReadiness, useSshIdentity } from '@/api/hooks'
import { useRecheckReadiness } from '@/api/mutations'
import { machineReadinessQuery } from '@/api/queries'
import { ago, at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Lead } from '@/m3/lead/Lead'
import { List, ListItem } from '@/m3/list/List'
import { State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { Track } from '@/m3/track/Track'
import { useTick } from '@/useTick'
import { stamp } from '../dashboard/bands'
import {
  github,
  line,
  machines as machinesStep,
  marks,
  ready,
  remedy,
  sshKey,
  statusWord,
  tailnet,
  type Line,
  type Step,
} from './steps'
import './Setup.css'

const STEPS = 6

function Copyable(props: { text: string }) {
  const { text } = props
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // No clipboard here; the text is still on screen to select.
    }
  }
  return (
    <div className="setup__copy">
      <Mono className="setup__code">{text}</Mono>
      <Button icon={copied ? <Check /> : <Copy />} onClick={copy} variant="text">
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

const tones = { done: 'primary', progress: 'tertiary', todo: 'high', failed: 'error' } as const

function Item(props: { title: string; step: Step; lead: ReactNode; trailing?: ReactNode; yours?: boolean }) {
  const { title, step, lead, trailing, yours } = props
  return (
    <ListItem
      headline={title}
      leading={<Lead tone={yours ? 'primary' : tones[step.status]}>{lead}</Lead>}
      supporting={
        <State size="small" state={yours ? 'needs' : marks[step.status]}>
          {yours ? 'waiting on you' : statusWord[step.status]} · {step.words}
        </State>
      }
      trailing={trailing}
    />
  )
}

function MachineLine(props: { machine: Machine; line: Line; report: Readiness | null; publicKey: string | null }) {
  const { machine, line: said, report, publicKey } = props
  const recheck = useRecheckReadiness()
  const mark = said.kind === 'ready' ? 'done' : said.kind === 'unreachable' ? 'unknown' : 'idle'
  return (
    <li className="setup__line" data-kind={said.kind}>
      <State size="small" state={mark}>
        <span className="setup__machine">{machine.name}</span>
      </State>
      <div aria-live="polite" className="setup__said">
        {said.kind === 'unchecked' ? (
          <Text scale="body-small" tone="variant">
            not checked yet · a check costs one ssh round trip
          </Text>
        ) : said.kind === 'unreachable' ? (
          <Text className="setup__bad" scale="body-small">
            {said.words}
          </Text>
        ) : said.kind === 'refused' ? (
          <>
            <Text scale="body-small" tone="variant">
              key not placed · the key is refused · run this once on {machine.name}:
            </Text>
            {publicKey ? (
              <Copyable text={remedy(publicKey)} />
            ) : (
              <Text scale="body-small" tone="variant">
                create the key first, step 2
              </Text>
            )}
          </>
        ) : (
          <Text scale="body-small" tone="variant">
            {said.kind === 'ready' ? `ready · ${said.words}` : said.words} · {said.present} of {said.total} checks
          </Text>
        )}
        {recheck.error ? (
          <ErrorSurface.Inline error={recheck.error} title={`${machine.name} was not asked`} />
        ) : null}
      </div>
      <Button disabled={recheck.isPending} onClick={() => recheck.mutate(machine.name)} variant="text">
        {recheck.isPending ? 'asking…' : report ? 'Check again' : 'Check'}
      </Button>
    </li>
  )
}

/** D3 §4.8: `/` while no workspace exists. The machines are the tailnet's,
 *  each asked on request, because the readiness sweep asks only the machines
 *  a workspace names. */
export function Setup() {
  const about = useAbout()
  const identity = useSshIdentity()
  const connection = useGithub()
  const machines = useMachines()
  const sweep = useReadiness()
  const now = useTick(true)

  const list = machines.looked === 'ok' ? machines.data : []
  // A recheck answers into the per-machine key; nothing here reads that key
  // over the wire, so an unasked machine draws as unasked rather than as a 404.
  const asked = useQueries({
    queries: list.map((one) => ({ ...machineReadinessQuery(one.name), enabled: false })),
  })
  const lines = list.map((machine, index) => {
    const own = asked[index]?.data
    const report =
      own?.looked === 'ok'
        ? own.data
        : sweep.looked === 'ok'
          ? (sweep.data.find((one) => one.machine === machine.name) ?? null)
          : null
    const since = machine.last_seen ? (at(machine.last_seen, now)?.text ?? null) : null
    return { machine, report, line: line(machine, report, since) }
  })
  const readyCount = lines.filter((one) => ready(one.line)).length
  const publicKey = identity.data?.public_key ?? null

  const steps = {
    tailnet: tailnet(about, location.protocol),
    ssh: sshKey(identity),
    machines: machinesStep(lines.map((one) => ({ machine: one.machine.name, line: one.line }))),
    github: github(connection),
    push: { status: 'todo', words: 'an ntfy topic, saved once, tested once' } satisfies Step,
    first: {
      status: 'todo',
      words: `needs one ready machine, you have ${readyCount === 0 ? 'none yet' : readyCount}`,
    } satisfies Step,
  }
  const done = Object.values(steps).filter((one) => one.status === 'done').length
  const read = stamp([
    { name: 'machines', reading: machines },
    { name: 'readiness', reading: sweep },
  ])

  return (
    <div className="setup">
      <div className="setup__head">
        <Text as="h1" emphasized scale="display-small">
          Set up Yantra
        </Text>
        <Text scale="body-medium" tone="variant">
          the appliance is running; it checks each step itself and tells you what is left
        </Text>
      </div>

      {machines.looked === 'pending' ? (
        <div className="setup__progress" data-slot="reading">
          <Skeleton shape="text" style={{ width: 200 }} />
          <Skeleton style={{ height: 320 }} />
        </div>
      ) : (
        <>
          <div className="setup__progress">
            <div className="setup__count">
              <Mono>
                {done} of {STEPS} done
              </Mono>
              {read ? (
                <Mono className="setup__stamp">
                  as of {ago(read.age, now).text}
                  {read.late.map((one) => ` · ${one.name} ${ago(one.age, now).text}`)}
                </Mono>
              ) : null}
            </div>
            <Track className="setup__track" label={`${done} of ${STEPS} steps done`} value={done / STEPS} />
          </div>

          <List className="setup__list">
            <Item
              lead={<Check />}
              step={steps.tailnet}
              title="The appliance is on your tailnet"
              trailing={
                <Button render={<Link params={{ category: 'about' }} to="/settings/$category" />} role="link" variant="text">
                  Open
                </Button>
              }
            />
            <Item lead={<Check />} step={steps.ssh} title="This account's ssh key" />
            {publicKey ? (
              <li className="setup__sub">
                <Copyable text={publicKey} />
              </li>
            ) : null}
            <Item lead={<Check />} step={steps.machines} title="Machines" />
            {machines.looked === 'failed' ? (
              <li className="setup__sub">
                <ErrorSurface.Inline error={fromReading(machines)!} title="Machines could not be read" />
              </li>
            ) : lines.length > 0 ? (
              <li className="setup__sub">
                <ul className="setup__lines">
                  {lines.map((one) => (
                    <MachineLine key={one.machine.name} line={one.line} machine={one.machine} publicKey={publicKey} report={one.report} />
                  ))}
                </ul>
              </li>
            ) : null}
            <Item
              lead={<GitBranch />}
              step={steps.github}
              title="GitHub"
              trailing={
                steps.github.status === 'done' ? undefined : (
                  <Button render={<Link params={{ category: 'providers' }} to="/settings/$category" />} role="link" variant="tonal">
                    Connect
                  </Button>
                )
              }
            />
            <Item
              lead={<Radio />}
              step={steps.push}
              title="Push to your phone"
              trailing={
                <Button render={<Link params={{ category: 'notifications' }} to="/settings/$category" />} role="link">
                  Set up
                </Button>
              }
            />
            <Item
              lead={<ArrowRight />}
              step={steps.first}
              title="Your first session"
              trailing={
                <Button icon={<Plus />} render={<Link to="/new" />} role="link">
                  New session
                </Button>
              }
              yours
            />
          </List>
        </>
      )}

      <div className="setup__foot">
        <Text scale="body-medium" tone="variant">
          Nothing here needs a terminal. Each step re-checks itself every few seconds.
        </Text>
        <Button className="setup__skip" render={<Link to="/fleet" />} role="link" variant="text">
          Skip for now
        </Button>
      </div>
    </div>
  )
}
