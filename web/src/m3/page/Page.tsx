import type { ComponentPropsWithRef } from 'react'
import { clsx } from 'clsx'
import './Page.css'

export type PageProps = ComponentPropsWithRef<'div'> & {
  /** `wide` is the dashboard's width; `reading` is a form or a single column. */
  width?: 'wide' | 'reading'
}

/** The skeletons of a pending page. `aria-busy` sits here and not on the Page,
 *  so a screen reader does not treat the title as loading too. */
export function PagePending(props: ComponentPropsWithRef<'div'>) {
  const { className, ...rest } = props
  return <div aria-busy="true" className={clsx('m3-page__pending', className)} data-slot="reading" {...rest} />
}

/** The one body every route draws in: one gutter (the shell's), one max width
 *  and one gap, whichever shell it sits under. */
export function Page(props: PageProps) {
  const { width, className, ...rest } = props
  return (
    <div
      className={clsx('m3-page', className)}
      data-width={width ?? 'wide'}
      {...rest}
    />
  )
}
