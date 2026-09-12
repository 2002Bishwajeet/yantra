import { useId, type ReactNode } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Check, GitBranch, Plus, Radio } from 'lucide-react'
import type { Machine, Readiness } from '@/api'
import { useScreenTitle } from '@/shell/title'
import { fromReading } from '@/api/client'
import { useAbout, useGithub, useMachines, useReadiness, useSshIdentity } from '@/api/hooks'
import { useRecheckReadiness } from '@/api/mutations'
import { machineReadinessQuery } from '@/api/queries'
import { apart, runsSessions } from '@/lib/platform'
import { ago, at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Copyable } from '@/m3/copyable/Copyable'
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
  joinCommand,
  joinUrl,
  line,
  machines as machinesStep,
  marks,
  push,
  ready,
  sshKey,
  statusWord,
  tailnet,
  type Line,
  type Step,
} from './steps'
import './Setup.css'

const STEPS = 6

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

/** The join command where it can be built, and why not where it cannot. */
function Join(props: { url: string | null; about: { error: Error | null; data: unknown }; what: string }) {
  const { url, about, what } = props
  if (url) return <Copyable text={joinCommand(url)} what={what} />
  return (
    <Text scale="body-small" tone="variant">
      {about.error
        ? "the daemon's address could not be read, so the join command cannot be built"
        : about.data
          ? 'the daemon reports no tailnet address, so the join command cannot be built · check that Tailscale is up on the appliance, then restart yantrad'
          : "reading the daemon's address…"}
    </Text>
  )
}

function MachineLine(props: { machine: Machine; line: Line; report: Readiness | null; join: ReactNode }) {
  const { machine, line: said, report, join } = props
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
              key refused · run the join command once in a terminal on {machine.name}:
            </Text>
            {join}
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
  const devices = useId()

  const all = machines.looked === 'ok' ? machines.data : []
  const list = all.filter(runsSessions)
  const others = all.filter((one) => !runsSessions(one))
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
  const join = joinUrl(location, about.data)

  const steps = {
    tailnet: tailnet(about, location.protocol),
    ssh: sshKey(identity),
    machines: machinesStep(lines.map((one) => ({ machine: one.machine.name, line: one.line }))),
    github: github(connection),
    push: push(about),
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

  useScreenTitle('Set up Yantra')
  return (
    <div className="setup">
      <div className="setup__head">
        <Text render={<h1 />} emphasized scale="display-small">
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
                <Copyable text={publicKey} what="the public key" />
              </li>
            ) : null}
            <Item lead={<Check />} step={steps.machines} title="Machines" />
            <li className="setup__sub">
              {machines.looked === 'failed' ? (
                <ErrorSurface.Inline error={fromReading(machines)!} title="Machines could not be read" />
              ) : lines.length > 0 ? (
                <ul className="setup__lines">
                  {lines.map((one) => (
                    <MachineLine
                      join={<Join about={about} url={join} what={`the join command for ${one.machine.name}`} />}
                      key={one.machine.name}
                      line={one.line}
                      machine={one.machine}
                      report={one.report}
                    />
                  ))}
                </ul>
              ) : null}
              {/* Y-390's guided Add a device starts here. */}
              <Text scale="body-small" tone="variant">
                To add a machine, run this once in a terminal on it. It turns on sshd, places this appliance's key
                and tells the daemon which account ran it.
              </Text>
              <div aria-live="polite">
                <Join about={about} url={join} what="the join command" />
              </div>
            </li>
            {others.length > 0 ? (
              <li className="setup__sub">
                <Text id={devices} scale="label-large" tone="variant">
                  Devices that open the dashboard
                </Text>
                <ul aria-labelledby={devices} className="setup__lines">
                  {others.map((one) => (
                    <li className="setup__line" data-kind="apart" key={one.name}>
                      <span className="setup__machine">{one.name}</span>
                      <Text className="setup__said" scale="body-small" tone="variant">
                        {apart(one)}
                      </Text>
                    </li>
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
          One step runs in a terminal: the join command, once on each new machine. Each step here re-checks itself
          every few seconds.
        </Text>
        <Button className="setup__skip" render={<Link to="/fleet" />} role="link" variant="text">
          Skip for now
        </Button>
      </div>
    </div>
  )
}
