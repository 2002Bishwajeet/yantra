import type { ComponentPropsWithRef } from 'react'
import { clsx } from 'clsx'
import './Page.css'

export type PageProps = ComponentPropsWithRef<'div'> & {
  /** `wide` is the dashboard's width; `reading` is a form or a single column. */
  width?: 'wide' | 'reading'
}

/** The one body every route draws in: centred, one gutter (the shell's), one
 *  max width and one gap, whichever shell it sits under. */
export function Page(props: PageProps) {
  const { width, className, ...rest } = props
  return <div className={clsx('m3-page', className)} data-width={width ?? 'wide'} {...rest} />
}
