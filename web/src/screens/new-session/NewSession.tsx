import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '@tanstack/react-form'
import { Link, useNavigate, useRouterState, useSearch } from '@tanstack/react-router'
import { useMachines } from '@/api/hooks'
import type { Step } from '@/router'
import { Button } from '@/m3/button/Button'
import { Dialog, DialogPopup } from '@/m3/dialog/Dialog'
import { Stepper } from '@/m3/stepper/Stepper'
import { Text } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { useFormFactor } from '@/shell/formFactor'
import { usePrefs } from '@/shell/prefs'
import { readGeneral } from '@/screens/settings/general'
import { complete, pickMachine, plan, type Plan, reachable, STEPS, type Values } from './form'
import { Starting } from './Starting'
import { StepName } from './StepName'
import { StepSource } from './StepSource'
import { StepStart } from './StepStart'
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

  // The list can arrive after mount, so the preset is resolved once it reads
  // ok; a pick made meanwhile is never overwritten.
  const machines = useMachines()
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || machines.looked !== 'ok') return
    seeded.current = true
    const picked = pickMachine(preset, machines.data)
    if (picked !== '' && form.getFieldValue('machine') === '') form.setFieldValue('machine', picked)
  }, [machines, preset, form])

  // A step the values do not reach yet draws the first one that is unfinished.
  const step = Math.min(requested, starting ? 4 : Math.min(3, reachable(values))) as Step
  const go = (to: Step) => void navigate({ to: '/new', search: { step: to } })

  const source = values.source
  const sourceLabel =
    source?.kind === 'github' ? source.repo.full_name : source ? source.path : null
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
      slot
    ) : (
      <Dialog open onOpenChange={(open) => !open && void navigate({ to: '/' })} disablePointerDismissal>
        <DialogPopup
          className="ns-dialog"
          dismiss="Close"
          {...(step === 1
            ? {
                title: 'New session',
                description: 'a name, a machine, a repository, and what to start in it',
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
        {phone ? <h1 className="ns__title">New session</h1> : null}
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
          <h1 className="ns__title">New session</h1>
          {step === 1 ? (
            <Text render={<p />} className="ns__lead" scale="body-medium" tone="variant">
              a name, a machine, a repository, and what to start in it
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

      {/* Panel 1 answers labels 1 and 2, so step 2 is at label 3 and step 3
          at label 4 (NewSession, NewSessionSource, NewSessionStart). */}
      <Stepper className="ns__stepper" current={step === 1 ? 0 : step} steps={STEPS} />

      {step === 1 ? <StepName form={form} values={values} /> : null}
      {step === 2 ? <StepSource form={form} values={values} /> : null}
      {step === 3 ? <StepStart form={form} values={values} /> : null}

      <footer className="ns__foot">
        {step === 1 ? (
          <Button role="link" render={<Link to="/" />} variant="text">
            Cancel
          </Button>
        ) : (
          <Button onClick={() => go((step - 1) as Step)} type="button" variant="text">
            Back
          </Button>
        )}
        <Button disabled={!complete(step, values)} type="submit">
          {step === 3 ? 'Create and open' : 'Continue'}
        </Button>
      </footer>
    </form>,
  )
}
