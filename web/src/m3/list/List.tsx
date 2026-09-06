import type { ComponentPropsWithRef, ReactNode } from 'react'
import { useRender } from '@base-ui/react/use-render'
import { ChevronRight } from 'lucide-react'
import { clsx } from 'clsx'
import './List.css'

export type ListProps = ComponentPropsWithRef<'ul'>

/** The grouped list the Settings boards draw: white, radius 20, hairlines. */
export function List(props: ListProps) {
  const { className, ...rest } = props
  return <ul className={clsx('m3-list', className)} {...rest} />
}

export type ListItemProps = useRender.ComponentProps<'div'> & {
  leading?: ReactNode
  headline: ReactNode
  supporting?: ReactNode
  /** A value, a chevron, a switch or a button. */
  trailing?: ReactNode
}

/** One row of a List. It is a link or a button when `render` says so, and the
 *  `<li>` stays outside the control so a switch in `trailing` keeps its own
 *  focus. */
export function ListItem(props: ListItemProps) {
  const { leading, headline, supporting, trailing, className, render, ...rest } = props
  const body = useRender({
    render,
    defaultTagName: 'div',
    props: {
      className: clsx('m3-list-item', render && 'm3-interactive', className),
      ...rest,
      children: (
        <>
          {leading ? <span className="m3-list-item__leading">{leading}</span> : null}
          <span className="m3-list-item__text">
            <span className="m3-list-item__headline m3-clip">{headline}</span>
            {supporting ? <span className="m3-list-item__supporting m3-clip">{supporting}</span> : null}
          </span>
        </>
      ),
    },
  })
  return (
    <li className="m3-list__row">
      {body}
      {trailing ? <span className="m3-list-item__trailing">{trailing}</span> : null}
    </li>
  )
}

export type ListValueProps = ComponentPropsWithRef<'span'>

/** A trailing value: "Set · replaced 4 Sep", a hostname, a count. */
export function ListValue(props: ListValueProps) {
  const { className, ...rest } = props
  return <span className={clsx('m3-list-value', className)} {...rest} />
}

/** The trailing chevron of a row that pushes a screen. */
export function ListChevron() {
  return (
    <span className="m3-list-chevron" aria-hidden="true">
      <ChevronRight />
    </span>
  )
}
