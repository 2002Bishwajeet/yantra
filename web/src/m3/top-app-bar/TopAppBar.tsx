import type { ComponentPropsWithRef, ReactNode } from 'react'
import { clsx } from 'clsx'
import './TopAppBar.css'

export type TopAppBarProps = ComponentPropsWithRef<'header'> & {
  title: ReactNode
  /** A back or menu IconButton. */
  leading?: ReactNode
  /** IconButtons and the avatar, right-aligned. */
  actions?: ReactNode
}

/** The small top app bar, 64 high, the page title as the h1. */
export function TopAppBar(props: TopAppBarProps) {
  const { title, leading, actions, className, ...rest } = props
  return (
    <header className={clsx('m3-top-app-bar', className)} {...rest}>
      {leading ? <div className="m3-top-app-bar__leading">{leading}</div> : null}
      <h1 className="m3-top-app-bar__title m3-clip">{title}</h1>
      {actions ? <div className="m3-top-app-bar__actions">{actions}</div> : null}
    </header>
  )
}
