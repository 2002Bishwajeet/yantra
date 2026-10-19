import { useEffect, useEffectEvent, useRef } from 'react'
import type { Machine, PlacementAsk } from '@/api'
import type { ApiError } from '@/api/errors'
import { usePlacement } from '@/api/mutations'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Text } from '@/m3/text/Text'
import { usePrefs } from '@/shell/prefs'
import { cloneFolders } from './clonePath'
import { pickMachine, type Source, type Values } from './form'
import type { SessionForm } from './useSessionForm'

function Failed(props: { title: string; error: ApiError | null; retry: () => void }) {
  if (!props.error) return null
  return (
    <ErrorSurface.Inline
      action={
        <Button onClick={props.retry} type="button" variant="text">
          Ask again
        </Button>
      }
      error={props.error}
      title={props.title}
    />
  )
}

/** Step 1 (Y-517): asks once with no source, and preselects the top machine
 *  unless a preset, a default machine or a pick by hand already decided. */
export function SuggestMachine(props: { form: SessionForm; values: Values; machines: Machine[]; preset: string }) {
  const { form, values, machines, preset } = props
  const placement = usePlacement()
  const { mutate } = placement
  useEffect(() => mutate({}), [mutate])

  const top = placement.data?.ranked[0]
  const chosen = useRef(false)
  const choose = useEffectEvent((machine: string) => {
    if (chosen.current || preset !== '' || values.machine !== '') return
    chosen.current = true
    const usable = pickMachine(machine, machines)
    if (usable !== '') form.setFieldValue('machine', usable)
  })
  useEffect(() => {
    if (top) choose(top.machine)
  }, [top])

  return (
    <>
      <Text aria-live="polite" render={<p role="status" />} className="ns__note" scale="body-medium" tone="variant">
        {placement.data
          ? top
            ? `${top.machine} suggested: ${top.reason}`
            : 'no machine reports a heartbeat, so none is suggested'
          : ''}
      </Text>
      <Failed error={placement.error} retry={() => mutate({})} title="No machine could be suggested" />
    </>
  )
}

const askFor = (source: Source): PlacementAsk =>
  source.kind === 'github' ? { repo: source.repo.full_name } : { path: source.path }

/** Step 2 (Y-517): asks again once a source is picked, and offers the machine
 *  that holds it when that is not the one chosen. */
export function SuggestSwitch(props: { form: SessionForm; values: Values }) {
  const { form, values } = props
  const prefs = usePrefs()
  const placement = usePlacement()
  const { mutate } = placement
  const { source, machine } = values
  const wanted = source ? askFor(source) : null
  const key = wanted ? `${wanted.repo ?? ''}|${wanted.path ?? ''}` : ''
  const ask = () => {
    if (wanted) mutate({ ...wanted, folders: cloneFolders(prefs) })
  }
  const askNow = useEffectEvent(ask)
  useEffect(() => {
    if (key !== '') askNow()
  }, [key])

  // An answer to an earlier source is not an answer to this one.
  const asked = placement.variables
  const current = wanted !== null && asked !== undefined && asked.repo === wanted.repo && asked.path === wanted.path
  const top = current ? placement.data?.ranked[0] : undefined
  const better = top && top.machine !== machine && top.path !== undefined ? { ...top, path: top.path } : null

  return (
    <div aria-live="polite" className="ns__suggest">
      {better && source ? (
        <>
          <Text render={<p />} className="ns__note" scale="body-medium">
            {`${better.machine}: ${better.reason}`}
          </Text>
          <Button
            onClick={() => {
              form.setFieldValue('machine', better.machine)
              form.setFieldValue(
                'source',
                source.kind === 'github'
                  ? { kind: 'github', repo: source.repo, path: better.path, here: 'yes' }
                  : { ...source, path: better.path, checked: 'yes', because: undefined },
              )
            }}
            type="button"
            variant="tonal"
          >
            {`Use ${better.machine}`}
          </Button>
        </>
      ) : null}
      {current ? <Failed error={placement.error} retry={ask} title="No other machine could be suggested" /> : null}
    </div>
  )
}
