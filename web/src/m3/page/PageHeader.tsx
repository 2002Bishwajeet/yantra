import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { Eyebrow } from '@/m3/text/Text'
import './PageHeader.css'

export type PageHeaderProps = {
  title: string
  /** A small label above the title. */
  eyebrow?: ReactNode
  /** The mono "looked 0s ago" line. */
  stamp?: ReactNode
  /** What sits beside the title: a state, a chip, one short line. */
  subtitle?: ReactNode
  /** The page's own verbs, at the far end. */
  actions?: ReactNode
  className?: string
}

/** The title row of a page. One flex row of a fixed height. The phone's app
 *  bar already names the page, so the shell hides this `h1` there and the
 *  stamp and the actions keep one row. */
export function PageHeader(props: PageHeaderProps) {
  const { title, eyebrow, stamp, subtitle, actions, className } = props
  return (
    <div
      className={clsx('m3-page-header', className)}
      data-bare={eyebrow || stamp || subtitle || actions ? undefined : ''}
      data-slot="page-header"
    >
      <div className="m3-page-header__title">
        {eyebrow ? <Eyebrow className="m3-page-header__eyebrow">{eyebrow}</Eyebrow> : null}
        <div className="m3-page-header__line">
          <h1 className="m3-page-header__h1 m3-wrap">{title}</h1>
          {subtitle}
        </div>
      </div>
      {stamp ? <div className="m3-page-header__stamp">{stamp}</div> : null}
      {actions ? <div className="m3-page-header__actions">{actions}</div> : null}
    </div>
  )
}
