import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Button as Base } from '@base-ui/react/button'
import { clsx } from 'clsx'
import './NavigationRail.css'

export type NavigationRailProps = ComponentPropsWithRef<'nav'> & {
  /** The FAB at the top of the rail. */
  fab?: ReactNode
  /** The bell and the avatar at the bottom. */
  trailing?: ReactNode
  children: ReactNode
}

/** The tablet's 96 px rail on surface-container-low, flat (R14 §6.2). */
export function NavigationRail(props: NavigationRailProps) {
  const { fab, trailing, className, children, ...rest } = props
  return (
    <nav className={clsx('m3-rail', className)} aria-label="Main" {...rest}>
      {fab ? <div className="m3-rail__fab">{fab}</div> : null}
      <div className="m3-rail__destinations">{children}</div>
      {trailing ? <div className="m3-rail__trailing">{trailing}</div> : null}
    </nav>
  )
}

export type DestinationProps = Base.Props & {
  icon: ReactNode
  /** Set when the destination is not a Link; a Link writes aria-current. */
  active?: boolean
  children: ReactNode
}

/** One rail destination: a 56 × 32 indicator over a label. */
export function RailDestination(props: DestinationProps) {
  const { icon, active, className, children, render, role, ...rest } = props
  return (
    <Base
      className={clsx('m3-destination', 'm3-interactive', className)}
      // `render` is a Link here: not a native button, and its own role.
      render={render}
      nativeButton={!render}
      role={role}
      aria-current={active ? 'page' : undefined}
      {...rest}
    >
      <span className="m3-destination__indicator" aria-hidden="true">
        {icon}
      </span>
      <span className="m3-destination__label">{children}</span>
    </Base>
  )
}
