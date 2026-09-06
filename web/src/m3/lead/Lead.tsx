import type { ComponentPropsWithRef, ReactNode } from 'react'
import { clsx } from 'clsx'
import './Lead.css'

export type LeadProps = ComponentPropsWithRef<'span'> & {
  tone?: 'high' | 'primary' | 'tertiary' | 'error'
  children: ReactNode
}

/** The 36 px circle a list item leads with. Decorative: the headline names
 *  the row. */
export function Lead(props: LeadProps) {
  const { tone, className, children, ...rest } = props
  return (
    <span className={clsx('m3-lead', className)} data-tone={tone ?? 'high'} aria-hidden="true" {...rest}>
      {children}
    </span>
  )
}
