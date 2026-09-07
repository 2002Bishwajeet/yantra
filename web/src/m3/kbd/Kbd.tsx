import type { ComponentPropsWithRef } from 'react'
import { clsx } from 'clsx'
import './Kbd.css'

export type KbdProps = ComponentPropsWithRef<'kbd'>

/** A key or a chord, drawn as the boards' ⌘K chip. */
export function Kbd(props: KbdProps) {
  const { className, ...rest } = props
  return <kbd className={clsx('m3-kbd', 'm3-mono', className)} {...rest} />
}
