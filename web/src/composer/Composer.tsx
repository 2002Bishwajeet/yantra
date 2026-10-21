import type { ComponentProps, ReactNode } from 'react'
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
      <div className="composer__card">
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
 *  software already holds the region when the first words arrive. */
export function Status(props: { children: ReactNode }) {
  return (
    <p className="composer__status" role="status">
      {props.children}
    </p>
  )
}

export { Input } from './Input'
