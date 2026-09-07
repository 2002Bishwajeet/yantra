import type { ComponentPropsWithRef, ReactNode } from 'react'
import { clsx } from 'clsx'
import { RailDestination, type DestinationProps } from '../navigation-rail/NavigationRail'
import './NavigationBar.css'

export type NavigationBarProps = ComponentPropsWithRef<'nav'> & { children: ReactNode }

/** The phone's bar: 64 high (R14 §6.1), four destinations across. */
export function NavigationBar(props: NavigationBarProps) {
  const { className, ...rest } = props
  return <nav className={clsx('m3-navigation-bar', className)} aria-label="Main" {...rest} />
}

export type BarDestinationProps = DestinationProps

/** The same destination as the rail's, stretched to a quarter of the bar. */
export function BarDestination(props: BarDestinationProps) {
  const { className, ...rest } = props
  return <RailDestination className={clsx('m3-navigation-bar__destination', className)} {...rest} />
}
