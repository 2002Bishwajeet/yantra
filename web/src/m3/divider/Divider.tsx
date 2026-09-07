import { Separator } from '@base-ui/react/separator'
import { clsx } from 'clsx'
import './Divider.css'

export type DividerProps = Separator.Props

/** One outline-variant hairline; `orientation="vertical"` for a toolbar. */
export function Divider(props: DividerProps) {
  const { className, ...rest } = props
  return <Separator className={clsx('m3-divider', className)} {...rest} />
}
