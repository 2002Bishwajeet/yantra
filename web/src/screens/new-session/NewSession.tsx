import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '@tanstack/react-form'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useRouterState, useSearch } from '@tanstack/react-router'
import { dirsQuery } from '@/api/queries'
import { loaded, useGithub, useGithubReadiness, useMachines, useRepos, useWorkspaces } from '@/api/hooks'
import { grant } from '@/lib/github'
import type { Workspace } from '@/api'
import type { Step } from '@/router'
import { Button } from '@/m3/button/Button'
import { Dialog, DialogPopup } from '@/m3/dialog/Dialog'
import { Page } from '@/m3/page/Page'
import { PageHeader } from '@/m3/page/PageHeader'
import { Stepper } from '@/m3/stepper/Stepper'
import { Text } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { useFormFactor } from '@/shell/formFactor'
import { usePrefs } from '@/shell/prefs'
import { readGeneral } from '@/screens/settings/general'
import { useCloneFolder } from './clonePath'
import { complete, knownWorkspace, pickMachine, plan, type Plan, reachable, sourceHint, STEPS, tilde, type Values } from './form'
import { Starting } from './Starting'
import { StepName } from './StepName'
import { StepSource } from './StepSource'
import { StepStart } from './StepStart'
import { useOffered } from './useOffered'
import { useSessionForm } from './useSessionForm'
import { generateName } from './words'
import './NewSession.css'

/** `?machine=` is what the Machine screen links with. The route validates
 *  `step` only, so it is read off the location rather than the match. */
const usePresetMachine = () =>
  useRouterState({
    select: (state) => {
      const given = (state.location.search as Record<string, unknown>).machine
      return typeof given === 'string' ? given : ''
    },
  })

const HINT_ID = 'ns-source-hint'

function SourceHint(props: { values: Values; known: Workspace | null }) {
  const { root, home } = useCloneFolder(props.values.machine)
  const github = useGithub()
  const repos = useRepos()
  const refused = grant(github.data, useGithubReadiness()).kind === 'refused'
  const listed =
    !github.error && github.data?.connected === true && !refused && repos.looked === 'ok' && !home.error
  const hint = sourceHint(props.values, root, listed)
  const { known } = props
  return (
    <>
      <Text className="ns__hint" id={HINT_ID} render={<p role="status" />} scale="body-medium" tone="variant">
        {hint}
      </Text>
      {known ? (
        <p className="ns__known">
          <Text scale="body-medium" tone="variant">
            {known.name} already works in this folder. Start a thread in its chat.
          </Text>
          <Button render={<Link params={{ name: known.name }} search={{ view: 'chat' }} to="/w/$name" />}>
            Open {known.name}
          </Button>
        </p>
      ) : null}
    </>
  )
}

const CONTENTS = { display: 'contents' } as const

function defaults(): Values {
  return {
    name: generateName(),
    named: false,
    machine: '',
    provider: 'github',
    source: null,
    opens: 'claude',
    command: '',
  }
}

/** Three panels on one form (Y-349): name and machine, source, start, then
 *  the starting screen. The panel lives in `?step=`; the values live here. */
export function NewSession() {
  const navigate = useNavigate()
  const requested = useSearch({ from: '/home/new' }).step ?? 1
  const phone = useFormFactor() === 'phone'
  const presetMachine = usePresetMachine()
  const defaultMachine = readGeneral(usePrefs()).defaultMachine
  const preset = presetMachine || defaultMachine || ''
  const [starting, setStarting] = useState<Plan | null>(null)
  const form = useSessionForm(defaults(), (values) => {
    const next = plan(values)
    if (!next) return
    setStarting(next)
    void navigate({ to: '/new', search: { step: 4 } })
  })
  const values = useStore(form.store, (state) => state.values)
  const workspaces = loaded(useWorkspaces())
  const known = workspaces.looked === 'ok' ? knownWorkspace(values, workspaces.data) : null

  // The list can arrive after mount, so the preset is resolved once it reads
  // ok; a pick made meanwhile is never overwritten.
  const machines = useMachines()
  const { shown, waiting } = useOffered()
  const seeded = useRef(false)
  useEffect(() => {
    // A hub is offered only once readiness shows an account on it joined (Y-627).
    if (seeded.current || machines.looked !== 'ok' || waiting) return
    seeded.current = true
    const picked = pickMachine(preset, shown)
    if (picked !== '' && form.getFieldValue('machine') === '') form.setFieldValue('machine', picked)
  }, [machines.looked, waiting, shown, preset, form])

  // A step the values do not reach yet draws the first one that is unfinished.
  const step = Math.min(requested, starting ? 4 : Math.min(3, reachable(values))) as Step
  const go = (to: Step) => void navigate({ to: '/new', search: { step: to } })

  const source = values.source
  const home = useQuery({ ...dirsQuery(values.machine, null), enabled: true })
  const sourceLabel = source ? tilde(source.path, home.data?.path ?? null) : null
  const on = `on ${values.machine}${step === 3 && sourceLabel ? ` · ${sourceLabel}` : ''}`

  // The body is portalled into one host node that moves between the page and
  // the dialog, so a form-factor change keeps its state and a running Starting (Y-361).
  const [host] = useState(() => {
    const node = document.createElement('div')
    Object.assign(node.style, CONTENTS)
    return node
  })
  const seat = useCallback((slot: HTMLElement | null) => void slot?.appendChild(host), [host])
  const screen = (body: ReactNode) => (
    <>
      {frame(<div ref={seat} style={CONTENTS} />)}
      {createPortal(body, host)}
    </>
  )
  const frame = (slot: ReactNode) =>
    phone ? (
      <Page width="reading">
        <PageHeader title="New session" />
        {slot}
      </Page>
    ) : (
      <Dialog open onOpenChange={(open) => !open && void navigate({ to: '/' })} disablePointerDismissal>
        <DialogPopup
          className="ns-dialog"
          dismiss="Close"
          {...(step === 1
            ? {
                title: 'New session',
                description: 'Name, machine, repository, start.',
              }
            : {
                leading: <Tile className="ns-dialog__tile" name={values.name} />,
                title: values.name,
                description: on,
              })}
        >
          {slot}
        </DialogPopup>
      </Dialog>
    )

  if (step === 4 && starting) {
    return screen(
      <div className="ns">
        <Starting plan={starting} onBack={() => go(3)} />
      </div>,
    )
  }

  return screen(
    <form
      className="ns"
      onSubmit={(event) => {
        event.preventDefault()
        if (step < 3) {
          if (complete(step, values)) go((step + 1) as Step)
          return
        }
        void form.handleSubmit()
      }}
    >
      {phone ? (
        <header className="ns__head">
          {step === 1 ? (
            <Text render={<p />} className="ns__lead" scale="body-medium" tone="variant">
              Name, machine, repository, start.
            </Text>
          ) : (
            <p className="ns__recap">
              <Tile name={values.name} size="small" />
              <Text emphasized scale="title-medium">
                {values.name}
              </Text>
              <Text scale="body-medium" tone="variant">
                {on}
              </Text>
            </p>
          )}
        </header>
      ) : null}

      <Stepper className="ns__stepper" current={step - 1} steps={STEPS} />

      {step === 1 ? <StepName form={form} preset={preset} values={values} /> : null}
      {step === 2 ? <StepSource form={form} values={values} /> : null}
      {step === 3 ? <StepStart form={form} values={values} /> : null}

      <footer className="ns__foot">
        {step === 2 ? <SourceHint known={known} values={values} /> : null}
        {step === 1 ? (
          <Button role="link" render={<Link to="/" />} variant="text">
            Cancel
          </Button>
        ) : (
          <Button onClick={() => go((step - 1) as Step)} type="button" variant="text">
            Back
          </Button>
        )}
        <Button
          aria-describedby={step === 2 && !complete(step, values) ? HINT_ID : undefined}
          disabled={!complete(step, values)}
          type="submit"
          variant={step === 2 && known ? 'tonal' : undefined}
        >
          {step === 3 ? 'Create and open' : 'Continue'}
        </Button>
      </footer>
    </form>,
  )
}
