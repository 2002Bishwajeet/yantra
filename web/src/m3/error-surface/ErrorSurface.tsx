import type { ComponentPropsWithRef, ReactNode } from 'react'
import { clsx } from 'clsx'
import type { ApiError } from '@/api/errors'
import { Button } from '../button/Button'
import { State } from '../mark/Mark'
import { Eyebrow, Mono } from '../text/Text'
import './ErrorSurface.css'

/** What a surface needs of an error: `api/errors.ts` gives exactly this. */
export type Described = Pick<ApiError, 'kind' | 'said' | 'retryable'> & { describe: () => string }

export type ErrorSurfaceProps = ComponentPropsWithRef<'section'> & {
  /** The eyebrow: "Fleet", "Session / Chat". */
  eyebrow?: string
  title: string
  error: Described
  /** Try again. Omitted, or a non-retryable error, draws no filled button. */
  reset?: () => void
  /** The two things this page cannot tell apart, each drawn unknown. */
  unknowns?: readonly string[]
  /** "last good read 2m ago", when there was one. */
  meta?: string
  /** The optional text button beside Try again. */
  action?: ReactNode
}

/** Every layout announces one way, and it is the live region: `role="alert"`
 *  reads the whole board, where a focus move reads the title alone and takes
 *  the caret from wherever the reader left it. Do not add both back (row 79). */
function Body(props: ErrorSurfaceProps & { layout: 'page' | 'card' | 'inline' }) {
  const { layout, eyebrow, title, error, reset, unknowns, meta, action, className, ...rest } = props
  const retry = reset && error.retryable
  return (
    <section
      className={clsx('m3-error', className)}
      data-layout={layout}
      role="alert"
      {...rest}
    >
      {layout === 'page' ? <span className="m3-error__mark" aria-hidden="true" /> : null}
      <div className="m3-error__text">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <h2 className="m3-error__title">{title}</h2>
        <p className="m3-error__sentence">{error.describe()}</p>
        {error.said ? (
          <Mono className="m3-error__said" clip={layout === 'inline'}>
            {error.said}
          </Mono>
        ) : null}
      </div>
      {unknowns?.length ? (
        <ul className="m3-error__unknowns">
          {unknowns.map((one, i) => (
            <li key={i}>
              <State state="unknown">
                {one} · <span className="m3-error__word">unknown</span>
              </State>
            </li>
          ))}
        </ul>
      ) : null}
      {meta ? <Mono className="m3-error__meta">{meta}</Mono> : null}
      {retry || action ? (
        <div className="m3-error__actions">
          {retry ? <Button onClick={reset}>Try again</Button> : null}
          {action}
        </div>
      ) : null}
    </section>
  )
}

/** Inside a bento cell, on the container tier at the card radius. The Page
 *  and Inline variants hang off it. */
export function ErrorSurface(props: ErrorSurfaceProps) {
  return <Body layout="card" {...props} />
}

/** Centred, full height: the Unreachable board. */
ErrorSurface.Page = function Page(props: ErrorSurfaceProps) {
  return <Body layout="page" {...props} />
}

ErrorSurface.Card = ErrorSurface

/** One row, for a tab or a list. */
ErrorSurface.Inline = function Inline(props: ErrorSurfaceProps) {
  return <Body layout="inline" {...props} />
}
