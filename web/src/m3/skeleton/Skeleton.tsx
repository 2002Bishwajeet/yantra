import type { ComponentPropsWithRef, CSSProperties } from 'react'
import { clsx } from 'clsx'
import './Skeleton.css'

export type SkeletonProps = ComponentPropsWithRef<'div'> & {
  /** A text line, a round lead, a block, or a card or a row at the size of the real one. */
  shape?: 'text' | 'round' | 'block' | 'card' | 'row'
  /** A `card`'s height in rows of body (the card tokens add the padding). */
  lines?: number
}

/** A read that has not resolved draws bars, never a sentence (EmptyStates
 *  board). Hidden from readers; the parent says it is loading. */
export function Skeleton(props: SkeletonProps) {
  const { shape, lines, className, style, ...rest } = props
  return (
    <div
      className={clsx('m3-skeleton', className)}
      data-shape={shape ?? 'block'}
      data-slot="skeleton"
      aria-hidden="true"
      style={lines === undefined ? style : ({ '--m3-skeleton-lines': lines, ...style } as CSSProperties)}
      {...rest}
    />
  )
}
