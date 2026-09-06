import type { ReactNode } from 'react'
import { Button as Base } from '@base-ui/react/button'
import { clsx } from 'clsx'
import './IconButton.css'

export type IconButtonProps = Base.Props & {
  /** The accessible name; an icon has none of its own. A badge's label joins it. */
  label: string
  /** `tonal` is the boards' surface-container-high circle. */
  variant?: 'standard' | 'tonal' | 'filled'
  /** A Badge, drawn at the top-right corner. */
  badge?: ReactNode
  children?: ReactNode
}

/** 44 px drawn, 48 px hit (ADR-0024 §4). */
export function IconButton(props: IconButtonProps) {
  const { label, variant, badge, className, children, ...rest } = props
  return (
    <Base
      className={clsx('m3-icon-button', 'm3-interactive', className)}
      data-variant={variant ?? 'standard'}
      {...rest}
    >
      <span className="m3-sr-only">{label}</span>
      <span className="m3-icon-button__icon" aria-hidden="true">
        {children}
      </span>
      {badge}
    </Base>
  )
}
