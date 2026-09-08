import type { ComponentPropsWithRef, ElementType } from 'react'
import { clsx } from 'clsx'
import './Card.css'

export type CardProps = ComponentPropsWithRef<'section'> & {
  variant?: 'filled' | 'elevated' | 'outlined'
  /** The tier or tint a filled card sits on; the hero is `primary`. */
  surface?:
    | 'container'
    | 'low'
    | 'high'
    | 'highest'
    | 'lowest'
    | 'primary'
    | 'secondary'
    | 'tertiary'
    | 'error'
  as?: ElementType
}

/** Radius 28 in Clean and 20 in Compact, from the density tokens. */
export function Card(props: CardProps) {
  const { variant, surface, as, className, ...rest } = props
  const Tag: ElementType = as ?? 'section'
  return (
    <Tag
      className={clsx('m3-card', className)}
      data-variant={variant ?? 'filled'}
      data-surface={surface ?? 'container'}
      {...rest}
    />
  )
}
