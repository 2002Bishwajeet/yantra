import type { ComponentPropsWithRef } from 'react'
import { clsx } from 'clsx'
import './Skeleton.css'

export type SkeletonProps = ComponentPropsWithRef<'div'> & {
  /** A text line, a round lead, or a row-shaped block. */
  shape?: 'text' | 'round' | 'block'
}

/** A read that has not resolved draws bars, never a sentence (EmptyStates
 *  board). Hidden from readers; the parent says it is loading. */
export function Skeleton(props: SkeletonProps) {
  const { shape, className, ...rest } = props
  return (
    <div
      className={clsx('m3-skeleton', className)}
      data-shape={shape ?? 'block'}
      data-slot="skeleton"
      aria-hidden="true"
      {...rest}
    />
  )
}
