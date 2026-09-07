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
 *  as a button the pill says it is pressed. */
export function Pill(props: PillProps) {
  const { selected, icon, className, children, ...rest } = props
  return (
    <Base
      className={clsx('m3-pill', 'm3-interactive', className)}
      data-selected={selected ? '' : undefined}
      aria-pressed={rest.render ? undefined : Boolean(selected)}
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
