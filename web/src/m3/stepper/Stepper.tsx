import type { ComponentPropsWithRef } from 'react'
import { Check } from 'lucide-react'
import { clsx } from 'clsx'
import './Stepper.css'

export type StepperProps = ComponentPropsWithRef<'ol'> & {
  steps: readonly string[]
  /** Index of the current step. */
  current: number
}

/** New session's four steps: done, current, ahead. */
export function Stepper(props: StepperProps) {
  const { steps, current, className, ...rest } = props
  return (
    <ol className={clsx('m3-stepper', className)} aria-label="Steps" {...rest}>
      {steps.map((step, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'ahead'
        return (
          <li
            key={step}
            className="m3-step"
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="m3-step__number" aria-hidden="true">
              {state === 'done' ? <Check /> : i + 1}
            </span>
            <span className="m3-step__label">
              {step}
              {state === 'done' ? <span className="m3-sr-only">, done</span> : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
