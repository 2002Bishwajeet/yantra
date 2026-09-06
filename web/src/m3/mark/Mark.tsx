import type { ComponentPropsWithRef, ReactNode } from 'react'
import { clsx } from 'clsx'
import { word } from './word'
import './Mark.css'

export type MarkState = 'needs' | 'running' | 'idle' | 'unknown' | 'done' | 'failed'

export type MarkProps = ComponentPropsWithRef<'span'> & {
  state: MarkState
  size?: 'default' | 'small'
}

/** The dot alone. Decorative: the word beside it is what a reader gets, so
 *  render it through State unless the word is already in the text. */
export function Mark(props: MarkProps) {
  const { state, size, className, ...rest } = props
  return (
    <span
      className={clsx('m3-mark', className)}
      data-state={state}
      data-size={size ?? 'default'}
      aria-hidden="true"
      {...rest}
    />
  )
}

export type StateProps = ComponentPropsWithRef<'span'> & {
  state: MarkState
  size?: 'default' | 'small'
  children?: ReactNode
}

/** Mark plus word, never colour alone (BRIEF.md, D3 §6). */
export function State(props: StateProps) {
  const { state, size, children, className, ...rest } = props
  return (
    <span className={clsx('m3-state', className)} data-state={state} {...rest}>
      <Mark state={state} size={size} />
      {children ?? word[state]}
    </span>
  )
}
