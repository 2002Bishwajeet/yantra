import { Link } from '@tanstack/react-router'
import type { UseMutationResult } from '@tanstack/react-query'
import type { Workspace, WorkspaceStatus } from '@/api'
import type { ApiError } from '@/api/errors'
import { useDown, useResume, useUp } from '@/api/mutations'
import { Button, type ButtonProps } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { chosen } from './verbs'

/** A daemon's refusal, drawn under the row that asked (D3 §8.1). `role=alert`
 *  is the surface's own, so the e2e finds the daemon's text by it. */
export function Said(props: { title: string; error: ApiError; reset: () => void }) {
  const { title, error, reset } = props
  return <ErrorSurface.Inline className="verb__said" error={error} reset={reset} title={title} />
}

type Pressed = { workspace: Workspace; variant?: ButtonProps['variant'] }

function Post<V>(props: {
  label: string
  busy: string
  refused: string
  mutation: UseMutationResult<unknown, ApiError, V>
  send: V
  variant?: ButtonProps['variant']
}) {
  const { label, busy, refused, mutation, send, variant } = props
  return (
    <>
      <Button disabled={mutation.isPending} onClick={() => mutation.mutate(send)} variant={variant}>
        {mutation.isPending ? busy : label}
      </Button>
      {mutation.error ? (
        <Said error={mutation.error} reset={() => mutation.mutate(send)} title={refused} />
      ) : null}
    </>
  )
}

/** `up`: a second Start attaches, which is the idempotent success (I-30). */
export function Start(props: Pressed) {
  const { workspace, variant } = props
  const up = useUp()
  return (
    <Post
      busy="starting…"
      label="Start"
      mutation={up}
      refused="Start was refused"
      send={workspace}
      variant={variant ?? 'filled'}
    />
  )
}

/** §4.7: a stopped session starts again, so Stop does not ask first. */
export function Stop(props: Pressed) {
  const { workspace, variant } = props
  const down = useDown()
  return (
    <Post
      busy="stopping…"
      label="Stop"
      mutation={down}
      refused="Stop was refused"
      send={workspace.name}
      variant={variant ?? 'text'}
    />
  )
}

/** Resume does not ask either: it respawns an ended agent (ADR-0015). */
export function Resume(props: Pressed) {
  const { workspace, variant } = props
  const resume = useResume()
  return (
    <Post
      busy="resuming…"
      label="Resume"
      mutation={resume}
      refused="Resume was refused"
      send={workspace.name}
      variant={variant ?? 'filled'}
    />
  )
}

/** The one verb a row's state is for (D1 §2), as the boards draw it. */
export function Verb(props: { workspace: Workspace; status: WorkspaceStatus | null }) {
  const { workspace, status } = props
  const one = chosen(workspace, status)
  switch (one.does) {
    case 'wait':
      return (
        <Button disabled variant="outlined">
          reading…
        </Button>
      )
    case 'fix':
      return (
        <Button render={<Link params={{ machine: workspace.machine }} to="/m/$machine" />} role="link" variant="outlined">
          Fix
        </Button>
      )
    case 'answer':
      return (
        <Button render={<Link params={{ name: workspace.name }} search={{ view: 'chat' }} to="/w/$name" />} role="link">
          Answer
        </Button>
      )
    case 'open':
      return (
        <Button render={<Link params={{ name: workspace.name }} to="/w/$name" />} role="link" variant="tonal">
          Open
        </Button>
      )
    case 'post':
      return one.verb === 'up' ? <Start workspace={workspace} /> : <Resume workspace={workspace} />
  }
}
