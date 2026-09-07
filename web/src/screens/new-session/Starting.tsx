import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useClone, useCreateWorkspace, useUp } from '@/api/mutations'
import { probeQuery } from '@/api/queries'
import { attachTerminal, terminalAddress } from '@/api/socket'
import { ago } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State, type MarkState } from '@/m3/mark/Mark'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { useTick } from '@/useTick'
import type { Plan } from './form'
import { run } from './run'
import { advance, begin, type Stage } from './stages'

const titles = (plan: Plan): Record<Stage['id'], string> => ({
  clone: plan.clone ? `Cloning ${plan.clone.full_name} into ${plan.path}` : 'Cloning',
  create: `Creating workspace ${plan.name}`,
  start: plan.startup ? `Running ${plan.startup}` : 'Starting claude',
  open: 'Opening chat',
})

const marks: Record<Stage['state'], MarkState> = {
  waiting: 'idle',
  running: 'running',
  done: 'done',
  skipped: 'done',
  refused: 'failed',
}

const words: Record<Stage['state'], string> = {
  waiting: 'waiting',
  running: 'running',
  done: 'done',
  skipped: 'not needed',
  refused: 'refused',
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/** The starting screen (NewSessionCloning): four stages in order, the clone
 *  read off its session's socket, and the chat opened at the end. */
export function Starting(props: { plan: Plan; onBack: () => void }) {
  const { plan, onBack } = props
  const navigate = useNavigate()
  const client = useQueryClient()
  const clone = useClone()
  const create = useCreateWorkspace()
  const up = useUp()
  const [stages, emit] = useReducer(advance, null, () =>
    begin(plan.clone !== null, `already on ${plan.machine} at ${plan.path}`),
  )
  const [attempt, setAttempt] = useState(0)
  const [since] = useState(() => Date.now())
  const now = useTick(stages.some((one) => one.state === 'running'))

  // Each attempt is one run; a newer attempt, or leaving, ends the older
  // one's say in the stages, and the socket it holds closes with it.
  const token = useRef(0)
  const start = useEffectEvent(() => {
    const mine = ++token.current
    const alive = () => token.current === mine
    void run(
      plan,
      stages,
      {
        clone: clone.mutateAsync,
        attach: (session, onLine, onEnd) => {
          const bytes = new TextDecoder()
          return attachTerminal(terminalAddress({ machine: plan.machine, session }), {
            size: () => ({ rows: 24, cols: 120 }),
            onBytes: (chunk) => onLine(bytes.decode(chunk, { stream: true })),
            onEnd,
            onLink: () => {},
          })
        },
        probe: (path) => client.fetchQuery(probeQuery(plan.machine, path)),
        create: create.mutateAsync,
        up: up.mutateAsync,
        open: (name) => void navigate({ to: '/w/$name', params: { name }, search: { view: 'chat' } }),
        sleep,
      },
      emit,
      alive,
    )
  })
  useEffect(() => {
    start()
    return () => {
      token.current += 1
    }
  }, [attempt])

  const refused = stages.find((one) => one.state === 'refused')
  const named = titles(plan)
  const retry = () => {
    emit({ type: 'retry' })
    setAttempt((was) => was + 1)
  }

  return (
    <div className="ns__starting">
      <header className="ns__recap">
        <Tile name={plan.name} />
        <Text as="h2" emphasized scale="title-large">
          Starting {plan.name}
        </Text>
        <Text scale="body-medium" tone="variant">
          on {plan.machine} · {plan.clone?.full_name ?? plan.path} · {plan.startup ?? 'Claude'}
        </Text>
      </header>

      <Card className="ns__card">
        <Eyebrow as="h3">Four things, in order</Eyebrow>
        <ol aria-label="Stages" className="ns__stages">
          {stages.map((stage) => (
            <li className="ns__stage" data-state={stage.state} key={stage.id}>
              <div className="ns__stage-line">
                <State state={marks[stage.state]}>{words[stage.state]}</State>
                <Text emphasized scale="title-medium">
                  {named[stage.id]}
                </Text>
                {stage.state === 'running' ? <Mono>{ago((now - since) / 1000, now).text}</Mono> : null}
              </div>
              {stage.detail ? <Mono className="ns__stage-detail">{stage.detail}</Mono> : null}
              {stage.state === 'refused' && stage.error ? (
                <ErrorSurface.Inline
                  action={stage.error.retryable ? null : <Button onClick={retry}>Try again</Button>}
                  error={stage.error}
                  reset={retry}
                  title={`${named[stage.id]} was refused`}
                />
              ) : null}
            </li>
          ))}
        </ol>
      </Card>

      <Text as="p" className="ns__note" scale="body-medium" tone="variant">
        {plan.clone
          ? `the clone keeps going on ${plan.machine} if you leave this page; open New session again to finish, and the clone already running is picked up.`
          : 'the session keeps going if you leave this page.'}
      </Text>

      <footer className="ns__foot">
        {refused ? (
          <Button onClick={onBack} type="button" variant="text">
            Back
          </Button>
        ) : null}
        <Button render={<Link to="/fleet" />} role="link" variant="text">
          Run in background
        </Button>
      </footer>
    </div>
  )
}
