import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Button as Base } from '@base-ui/react/button'
import { clsx } from 'clsx'
import './Pill.css'

export type PillProps = Base.Props & {
  selected?: boolean
  icon?: ReactNode
  children: ReactNode
}

/** The boards' tab and filter pill: S button height, secondary-container when
 *  selected. As a `<Link>` (through `render`) the router writes aria-current;
 *  as a button with `selected` the pill says whether it is pressed. */
export function Pill(props: PillProps) {
  const { selected, icon, className, children, render, role, ...rest } = props
  return (
    <Base
      className={clsx('m3-pill', 'm3-interactive', className)}
      // `render` is a Link here: not a native button, and its own role.
      render={render}
      nativeButton={!render}
      role={role}
      data-selected={selected ? '' : undefined}
      aria-pressed={render || selected === undefined ? undefined : selected}
      {...rest}
    >
      {icon ? (
        <span className="m3-pill__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </Base>
  )
}

export type PillGroupProps = ComponentPropsWithRef<'div'>

/** The surface-container-high track pills sit in. */
export function PillGroup(props: PillGroupProps) {
  const { className, ...rest } = props
  return <div className={clsx('m3-pill-group', className)} {...rest} />
}
