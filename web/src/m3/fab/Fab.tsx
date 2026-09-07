import type { ReactNode } from 'react'
import { Button as Base } from '@base-ui/react/button'
import { clsx } from 'clsx'
import './Fab.css'

export type FabProps = Base.Props & {
  label: string
  /** 56, or the Expressive medium at 80. Small is deprecated (R14 §1.1). */
  size?: 'default' | 'medium'
  children: ReactNode
}

/** The floating action button, primary-container as the boards draw it. */
export function Fab(props: FabProps) {
  const { label, size, className, children, render, ...rest } = props
  return (
    <Base
      className={clsx('m3-fab', 'm3-interactive', className)}
      data-size={size ?? 'default'}
      render={render}
      nativeButton={!render}
      {...rest}
    >
      <span className="m3-sr-only">{label}</span>
      <span className="m3-fab__icon" aria-hidden="true">
        {children}
      </span>
    </Base>
  )
}

export type ExtendedFabProps = Base.Props & {
  icon: ReactNode
  children: ReactNode
}

/** Icon and label side by side, 56 high. */
export function ExtendedFab(props: ExtendedFabProps) {
  const { icon, className, children, render, ...rest } = props
  return (
    <Base
      className={clsx('m3-fab', 'm3-interactive', className)}
      data-size="extended"
      render={render}
      nativeButton={!render}
      {...rest}
    >
      <span className="m3-fab__icon" aria-hidden="true">
        {icon}
      </span>
      {children}
    </Base>
  )
}
