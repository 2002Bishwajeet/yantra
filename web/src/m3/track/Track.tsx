import type { ComponentPropsWithRef } from 'react'
import { clsx } from 'clsx'
import './Track.css'

export type TrackProps = ComponentPropsWithRef<'div'> & {
  /** 0 to 1. */
  value: number
  /** What the bar measures: "elapsed, 3h 41m of the longest". */
  label: string
}

/** The boards' elapsed bar: 6 px, tertiary on the container tier. */
export function Track(props: TrackProps) {
  const { value, label, className, ...rest } = props
  const clamped = Math.min(1, Math.max(0, value))
  return (
    <div
      className={clsx('m3-track', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      {...rest}
    >
      <div className="m3-track__fill" style={{ width: `${clamped * 100}%` }} />
    </div>
  )
}
