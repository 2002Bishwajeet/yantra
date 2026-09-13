import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import { clsx } from 'clsx'
import './Stepper.css'

export type StepState = 'done' | 'current' | 'ahead' | 'stuck'

/** One step of the vertical form: its title, a line that says where it is,
 *  and the body a person works in while it is not done (D7 §5). */
export type StepItem = {
  title: ReactNode
  state: StepState
  words?: ReactNode
  body?: ReactNode
}

type Horizontal = {
  orientation?: 'horizontal'
  steps: readonly string[]
  /** Index of the current step. */
  current: number
}

type Vertical = {
  orientation: 'vertical'
  items: readonly StepItem[]
}

export type StepperProps = Omit<ComponentPropsWithRef<'ol'>, 'children'> & (Horizontal | Vertical)

const said: Partial<Record<StepState, string>> = { done: ', done', stuck: ', stuck' }

function Number(props: { state: StepState; index: number }) {
  return (
    <span className="m3-step__number" aria-hidden="true">
      {props.state === 'done' ? <Check /> : props.state === 'stuck' ? <TriangleAlert /> : props.index + 1}
    </span>
  )
}

/** New session's four steps across, or Add a device's beats down the page. A
 *  finished vertical step folds to its title and its line. */
export function Stepper(props: StepperProps) {
  if (props.orientation === 'vertical') {
    const { orientation, items, className, ...rest } = props
    return (
      <ol className={clsx('m3-stepper', className)} data-orientation={orientation} aria-label="Steps" {...rest}>
        {items.map((item, i) => (
          <li
            key={i}
            className="m3-step"
            data-state={item.state}
            aria-current={item.state === 'current' ? 'step' : undefined}
          >
            <Number index={i} state={item.state} />
            <div className="m3-step__content">
              <div className="m3-step__label">
                {item.title}
                {said[item.state] ? <span className="m3-sr-only">{said[item.state]}</span> : null}
              </div>
              {item.words}
              {item.state === 'done' ? null : item.body}
            </div>
          </li>
        ))}
      </ol>
    )
  }
  const { orientation: _, steps, current, className, ...rest } = props
  return (
    <ol className={clsx('m3-stepper', className)} aria-label="Steps" {...rest}>
      {steps.map((step, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'ahead'
        return (
          <li
            key={i}
            className="m3-step"
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <Number index={i} state={state} />
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
