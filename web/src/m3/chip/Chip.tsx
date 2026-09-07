import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Toggle } from '@base-ui/react/toggle'
import { Check } from 'lucide-react'
import { clsx } from 'clsx'
import './Chip.css'

export type ChipProps = ComponentPropsWithRef<'span'> & {
  /** Which container tier the label sits on. */
  tone?: 'lowest' | 'high' | 'primary' | 'tertiary' | 'error'
  icon?: ReactNode
  children: ReactNode
}

/** A label, not a control: a repo topic, a scope, an "unreachable". */
export function Chip(props: ChipProps) {
  const { tone, icon, className, children, ...rest } = props
  return (
    <span className={clsx('m3-chip', className)} data-tone={tone ?? 'lowest'} {...rest}>
      {icon ? (
        <span className="m3-chip__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  )
}

export type FilterChipProps = Toggle.Props & { children: ReactNode }

/** A chip that toggles, with the check that says so. */
export function FilterChip(props: FilterChipProps) {
  const { className, children, ...rest } = props
  return (
    <Toggle className={clsx('m3-chip', 'm3-chip--filter', 'm3-interactive', className)} {...rest}>
      <span className="m3-chip__icon m3-chip__check" aria-hidden="true">
        <Check />
      </span>
      {children}
    </Toggle>
  )
}
