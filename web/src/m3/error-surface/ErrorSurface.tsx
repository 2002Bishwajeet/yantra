import { useEffect, useId, useState, type ComponentPropsWithRef, type ReactNode } from 'react'
import { clsx } from 'clsx'
import type { ApiError } from '@/api/errors'
import { Button } from '../button/Button'
import { announce } from '../live/live'
import { State } from '../mark/Mark'
import { Eyebrow, Text } from '../text/Text'
import './ErrorSurface.css'

/** What a surface needs of an error: `api/errors.ts` gives exactly this, and
 *  `api/chat.ts` names kinds of its own. */
export type Described = Pick<ApiError, 'said' | 'retryable'> & { kind: string; describe: () => string; headline?: string }

export type ErrorSurfaceProps = ComponentPropsWithRef<'section'> & {
  /** The eyebrow names the failing read ("Fleet read", "Session / Chat"), never the title the PageHeader already draws. */
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
  /** A card or a row keeps the daemon's words behind Details, as the page
   *  does: for a refusal long enough to bury the sentence. */
  folded?: boolean
}

function Unknowns(props: { items: readonly string[] }) {
  return (
    <ul className="m3-error__unknowns">
      {props.items.map((one, i) => (
        <li key={i}>
          <State state="unknown">
            {one} · <span className="m3-error__word">unknown</span>
          </State>
        </li>
      ))}
    </ul>
  )
}

/** Every layout announces one way, and it is the live region: it reads the
 *  whole failure, where a focus move reads the title alone and takes the caret
 *  from wherever the reader left it. Do not add a focus move back (row 79). */
function Body(props: ErrorSurfaceProps & { layout: 'page' | 'card' | 'inline' }) {
  const { layout, eyebrow, title, error, reset, unknowns, meta, action, folded, className, ...rest } = props
  const retry = reset && error.retryable
  const page = layout === 'page'
  const fold = !page && folded && Boolean(error.said)
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const hasDetails = Boolean(error.said || unknowns?.length || meta)
  const heading = error.headline ?? title
  const words = `${heading}. ${error.describe()}`
  useEffect(() => announce(words), [words])
  return (
    <section
      className={clsx('m3-error', className)}
      data-layout={layout}
      role="alert"
      // The shell's region says this, because a surface drawn with its own
      // words is a region a reader may never hear (finding 111). The role
      // stays: it is what the surface is, and it is how a test finds it.
      aria-live="off"
      {...rest}
    >
      {layout === 'page' ? <span className="m3-error__mark" aria-hidden="true" /> : null}
      <div className="m3-error__text">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <h2 className="m3-error__title">{heading}</h2>
        <p className="m3-error__sentence">{error.describe()}</p>
        {!page && !fold && error.said ? (
          <Text scale="body-small" className="m3-error__said m3-wrap">
            {error.said}
          </Text>
        ) : null}
      </div>
      {page ? (
        <>
          {action ?? (retry ? <Button onClick={reset}>Try again</Button> : null)}
          {hasDetails ? (
            <>
              <Button
                aria-controls={detailsId}
                aria-expanded={open}
                className="m3-error__toggle"
                onClick={() => setOpen(!open)}
                variant="text"
              >
                Details
              </Button>
              {open ? (
                <div className="m3-error__details" id={detailsId}>
                  {error.said ? <Text scale="body-small" className="m3-error__said m3-wrap">{error.said}</Text> : null}
                  {unknowns?.length ? <Unknowns items={unknowns} /> : null}
                  {meta ? <Text scale="body-small" className="m3-error__meta m3-wrap">{meta}</Text> : null}
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <>
          {unknowns?.length ? <Unknowns items={unknowns} /> : null}
          {meta ? <Text scale="body-small" className="m3-error__meta m3-wrap">{meta}</Text> : null}
          {retry || action || fold ? (
            <div className="m3-error__actions">
              {retry ? <Button onClick={reset}>Try again</Button> : null}
              {action}
              {fold ? (
                <Button
                  aria-controls={detailsId}
                  aria-expanded={open}
                  className="m3-error__toggle"
                  onClick={() => setOpen(!open)}
                  variant="text"
                >
                  Details
                </Button>
              ) : null}
            </div>
          ) : null}
          {fold && open ? (
            <div className="m3-error__details" id={detailsId}>
              <Text scale="body-small" className="m3-error__said m3-wrap">{error.said}</Text>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

/** Inside a bento cell, on the container tier at the card radius. The Page
 *  and Inline variants hang off it. */
export function ErrorSurface(props: ErrorSurfaceProps) {
  return <Body layout="card" {...props} />
}

/** Centred in what the page has left under its PageHeader, so the title
 *  stays: the Unreachable board. */
ErrorSurface.Page = function Page(props: ErrorSurfaceProps) {
  return <Body layout="page" {...props} />
}

ErrorSurface.Card = ErrorSurface

/** One row, for a tab or a list. */
ErrorSurface.Inline = function Inline(props: ErrorSurfaceProps) {
  return <Body layout="inline" {...props} />
}
