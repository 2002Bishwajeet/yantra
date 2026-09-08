import { useState } from 'react'
import { useStore } from '@tanstack/react-form'
import { Link, useNavigate, useRouterState, useSearch } from '@tanstack/react-router'
import type { Step } from '@/router'
import { Button } from '@/m3/button/Button'
import { Stepper } from '@/m3/stepper/Stepper'
import { Text } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { complete, plan, type Plan, reachable, STEPS, type Values } from './form'
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

function defaults(machine: string): Values {
  return {
    name: generateName(),
    named: false,
    machine,
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
  const requested = useSearch({ from: '/new' }).step ?? 1
  const preset = usePresetMachine()
  const [starting, setStarting] = useState<Plan | null>(null)
  const form = useSessionForm(defaults(preset), (values) => {
    const next = plan(values)
    if (!next) return
    setStarting(next)
    void navigate({ to: '/new', search: { step: 4 } })
  })
  const values = useStore(form.store, (state) => state.values)

  // A step the values do not reach yet draws the first one that is unfinished.
  const step = Math.min(requested, starting ? 4 : Math.min(3, reachable(values))) as Step
  const go = (to: Step) => void navigate({ to: '/new', search: { step: to } })

  if (step === 4 && starting) {
    return (
      <div className="ns">
        <h1 className="ns__title">New session</h1>
        <Starting plan={starting} onBack={() => go(3)} />
      </div>
    )
  }

  const source = values.source
  const sourceLabel =
    source?.kind === 'github' ? source.repo.full_name : source ? source.path : null

  return (
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
      <header className="ns__head">
        <h1 className="ns__title">New session</h1>
        {step === 1 ? (
          <Text as="p" className="ns__lead" scale="body-medium" tone="variant">
            a name, a machine, a repository, and what to start in it
          </Text>
        ) : (
          <p className="ns__recap">
            <Tile name={values.name} size="small" />
            <Text emphasized scale="title-medium">
              {values.name}
            </Text>
            <Text scale="body-medium" tone="variant">
              on {values.machine}
              {step === 3 && sourceLabel ? ` · ${sourceLabel}` : ''}
            </Text>
          </p>
        )}
      </header>

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
    </form>
  )
}
