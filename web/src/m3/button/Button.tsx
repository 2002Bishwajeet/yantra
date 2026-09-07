import type { ReactNode } from 'react'
import { Button as Base } from '@base-ui/react/button'
import { clsx } from 'clsx'
import './Button.css'

export type ButtonProps = Base.Props & {
  /** M3 common buttons; `error` is the boards' Kill and Delete. */
  variant?: 'filled' | 'tonal' | 'outlined' | 'text'
  tone?: 'primary' | 'error'
  /** Expressive sizes S (40) and M (56). */
  size?: 's' | 'm'
  icon?: ReactNode
  children?: ReactNode
}

/** A pill button on Base UI's Button, so `render={<Link/>}` makes it a route. */
export function Button(props: ButtonProps) {
  const { variant, tone, size, icon, className, children, render, role, ...rest } = props
  return (
    <Base
      className={clsx('m3-button', 'm3-interactive', className)}
      // `render` is a Link here: not a native button, and its own role.
      render={render}
      nativeButton={!render}
      role={role}
      data-variant={variant ?? 'filled'}
      data-filled={(variant ?? 'filled') === 'filled' || variant === 'tonal' ? '' : undefined}
      data-tone={tone ?? 'primary'}
      data-size={size ?? 's'}
      {...rest}
    >
      {icon ? (
        <span className="m3-button__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </Base>
  )
}
