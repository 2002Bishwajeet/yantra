import type { ReactNode } from 'react'
import { Toggle } from '@base-ui/react/toggle'
import { ToggleGroup } from '@base-ui/react/toggle-group'
import { Check } from 'lucide-react'
import { clsx } from 'clsx'
import './Segmented.css'

export type SegmentedProps = Omit<ToggleGroup.Props, 'value' | 'defaultValue' | 'onValueChange' | 'toggleMultiple'> & {
  /** The group's accessible name: "Layout", "Theme". */
  label: string
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  children: ReactNode
}

/** A single-select segmented button: one Segment pressed at a time. */
export function Segmented(props: SegmentedProps) {
  const { label, value, defaultValue, onValueChange, className, ...rest } = props
  return (
    <ToggleGroup
      className={clsx('m3-segmented', className)}
      aria-label={label}
      value={value === undefined ? undefined : [value]}
      defaultValue={defaultValue === undefined ? undefined : [defaultValue]}
      onValueChange={(next) => {
        // A group with nothing pressed is not a state a segmented button has.
        if (next.length && onValueChange) onValueChange(String(next[0]))
      }}
      {...rest}
    />
  )
}

export type SegmentProps = Toggle.Props & {
  value: string
  icon?: ReactNode
  children: ReactNode
}

export function Segment(props: SegmentProps) {
  const { icon, className, children, ...rest } = props
  return (
    <Toggle className={clsx('m3-segment', 'm3-interactive', className)} {...rest}>
      <span className="m3-segment__icon" aria-hidden="true">
        <Check className="m3-segment__check" />
        {icon}
      </span>
      {children}
    </Toggle>
  )
}
