import { clsx } from 'clsx'
import type { ComponentPropsWithRef } from 'react'
import './Badge.css'

export type BadgeProps = ComponentPropsWithRef<'span'> & {
  /** What a reader hears; the number alone says nothing. */
  label: string
  /** Absent: the small dot. Present: the large badge with the count. */
  count?: number
}

export function Badge(props: BadgeProps) {
  const { label, count, className, ...rest } = props
  // Nothing to count is nothing to draw: a bell with no unread has no badge.
  if (count === 0) return null
  const large = count !== undefined
  return (
    <span
      className={clsx('m3-badge', large && 'm3-mono', className)}
      data-size={large ? 'large' : 'small'}
      {...rest}
    >
      {large ? <span aria-hidden="true">{count > 99 ? '99+' : count}</span> : null}
      <span className="m3-sr-only">{label}</span>
    </span>
  )
}
