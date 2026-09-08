import type { ReactNode } from 'react'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Check } from 'lucide-react'
import { clsx } from 'clsx'
import './Segmented.css'

export type SegmentedProps = Omit<RadioGroup.Props<string>, 'onValueChange'> & {
  /** The group's accessible name: "Layout", "Theme". */
  label: string
  onValueChange?: (value: string) => void
  children: ReactNode
}

/** A one-of-N choice, so Material's segmented button is a radio group: one
 *  Segment checked at a time, and the arrow keys move between them. */
export function Segmented(props: SegmentedProps) {
  const { label, onValueChange, className, ...rest } = props
  return (
    <RadioGroup
      className={clsx('m3-segmented', className)}
      aria-label={label}
      onValueChange={(value) => onValueChange?.(String(value))}
      {...rest}
    />
  )
}

export type SegmentProps = Radio.Root.Props<string> & {
  icon?: ReactNode
  children: ReactNode
}

export function Segment(props: SegmentProps) {
  const { icon, className, children, ...rest } = props
  return (
    <Radio.Root className={clsx('m3-segment', 'm3-interactive', className)} {...rest}>
      <span className="m3-segment__icon" aria-hidden="true">
        <Check className="m3-segment__check" />
        {icon}
      </span>
      {children}
    </Radio.Root>
  )
}
