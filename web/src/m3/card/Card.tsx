import { useRender } from '@base-ui/react/use-render'
import { clsx } from 'clsx'
import './Card.css'

export type CardProps = useRender.ComponentProps<'section'> & {
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
}

/** Radius 28 in Clean and 20 in Compact, from the density tokens. */
export function Card(props: CardProps) {
  const { variant, surface, className, render, ...rest } = props
  return useRender({
    render,
    defaultTagName: 'section',
    props: {
      className: clsx('m3-card', className),
      'data-variant': variant ?? 'filled',
      'data-surface': surface ?? 'container',
      ...rest,
    },
  })
}
