import type { ComponentPropsWithRef } from 'react'
import { clsx } from 'clsx'
import './Page.css'

export type PageProps = ComponentPropsWithRef<'div'> & {
  /** `wide` is the dashboard's width; `reading` is a form or a single column. */
  width?: 'wide' | 'reading'
  /** A conversation sits in the middle of the frame; every other reading page
   *  starts where the wide column starts, so a title keeps one left edge. */
  centered?: boolean
}

/** The one body every route draws in: one gutter (the shell's), one max width
 *  and one gap, whichever shell it sits under. */
export function Page(props: PageProps) {
  const { width, centered, className, ...rest } = props
  return (
    <div
      className={clsx('m3-page', className)}
      data-align={centered ? 'center' : undefined}
      data-width={width ?? 'wide'}
      {...rest}
    />
  )
}
