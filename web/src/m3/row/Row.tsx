import type { ComponentPropsWithRef, ReactNode } from 'react'
import { useRender } from '@base-ui/react/use-render'
import { clsx } from 'clsx'
import './Row.css'

export type RowProps = useRender.ComponentProps<'div'> & {
  /** The tier under the row; `selected` is the boards' secondary-container. */
  tone?: 'lowest' | 'plain' | 'selected' | 'translucent'
}

/** A session row: tile, text, trailing. With `render={<Link/>}` it is the
 *  link itself and gets the state layer and the 48 px hit area. */
export function Row(props: RowProps) {
  const { tone, className, render, ...rest } = props
  return useRender({
    render,
    defaultTagName: 'div',
    props: {
      className: clsx('m3-row', render && 'm3-interactive', className),
      'data-tone': tone ?? 'lowest',
      ...rest,
    },
  })
}

export type RowTextProps = ComponentPropsWithRef<'div'> & {
  headline: ReactNode
  supporting?: ReactNode
}

/** The two lines between the tile and the trailing value. */
export function RowText(props: RowTextProps) {
  const { headline, supporting, className, ...rest } = props
  return (
    <div className={clsx('m3-row__text', className)} {...rest}>
      <span className="m3-row__headline m3-clip">{headline}</span>
      {supporting ? <span className="m3-row__supporting m3-clip">{supporting}</span> : null}
    </div>
  )
}
