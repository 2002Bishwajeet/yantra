import type { ComponentProps, MouseEvent, ReactNode } from 'react'
import { clsx } from 'clsx'
import './Composer.css'

export type RootProps = Omit<ComponentProps<'form'>, 'children'> & {
  /** Nothing is typed or attached. With no focus the card rests as one line. */
  empty: boolean
  /** A file is being dragged over the card. */
  dropping?: boolean
  /** The plan badge: it sits on the card's top edge. */
  above?: ReactNode
  children: ReactNode
}

/** A press on the card that lands on no control puts the caret in the field, as T3 Code does. A menu is
 *  portalled out of the card, but React still bubbles its events here, so the DOM must hold the target. */
function focusField(event: MouseEvent<HTMLDivElement>) {
  const target = event.target as Element
  if (!event.currentTarget.contains(target) || target.closest('button, input, textarea, a, [role="dialog"]')) return
  const field = event.currentTarget.querySelector('textarea')
  if (!field || field.disabled) return
  event.preventDefault()
  field.focus()
}

/** The card the Chat and the Room both write in. */
export function Root(props: RootProps) {
  const { empty, dropping, above, className, children, ...rest } = props
  return (
    <form
      className={clsx('composer', className)}
      data-dropping={dropping ? '' : undefined}
      data-empty={empty ? '' : undefined}
      data-slot="composer-shell"
      {...rest}
    >
      {above}
      <div className="composer__card" onMouseDown={focusField}>
        {dropping ? (
          <p aria-hidden="true" className="composer__drop">
            Drop an image to attach it.
          </p>
        ) : null}
        {children}
      </div>
    </form>
  )
}

/** Controls on the left scroll sideways with their bar hidden; actions stay on the right. */
export function Footer(props: { controls?: ReactNode; actions: ReactNode }) {
  return (
    <div className="composer__footer">
      <div className="composer__controls">{props.controls}</div>
      <div className="composer__actions">{props.actions}</div>
    </div>
  )
}

/** A state change, said politely and shown. It stays in the page when empty so a reader's
 *  software already holds the region when the first words arrive. `quiet` keeps it said but
 *  not drawn, for a moment when the placeholder already shows the same words. */
export function Status(props: { children: ReactNode; quiet?: boolean }) {
  return (
    <p className={clsx('composer__status', props.quiet && 'm3-sr-only')} role="status">
      {props.children}
    </p>
  )
}

export { Input } from './Input'
