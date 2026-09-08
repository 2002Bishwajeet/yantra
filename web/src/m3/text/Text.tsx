import type { ComponentPropsWithRef } from 'react'
import { useRender } from '@base-ui/react/use-render'
import { clsx } from 'clsx'
import './Text.css'

export type TypeScale =
  | 'display-large'
  | 'display-medium'
  | 'display-small'
  | 'headline-large'
  | 'headline-medium'
  | 'headline-small'
  | 'title-large'
  | 'title-medium'
  | 'title-small'
  | 'body-large'
  | 'body-medium'
  | 'body-small'
  | 'label-large'
  | 'label-medium'
  | 'label-small'

export type TextProps = Omit<useRender.ComponentProps<'span'>, 'role'> & {
  scale: TypeScale
  emphasized?: boolean
  tone?: 'variant' | 'primary' | 'error'
  clip?: boolean
}

/** One Material type role. Defaults to a span; pass `render` for a heading. */
export function Text(props: TextProps) {
  const { scale, emphasized, tone, clip, className, render, ...rest } = props
  return useRender({
    render,
    defaultTagName: 'span',
    props: {
      className: clsx('m3-text', clip && 'm3-clip', className),
      'data-scale': scale,
      'data-emphasized': emphasized ? '' : undefined,
      'data-tone': tone,
      ...rest,
    },
  })
}

export type MonoProps = ComponentPropsWithRef<'span'> & { clip?: boolean }

/** IBM Plex Mono for an age, a duration, a count or an amount. */
export function Mono(props: MonoProps) {
  const { clip, className, ...rest } = props
  return <span className={clsx('m3-mono', clip && 'm3-clip', className)} {...rest} />
}

export type EyebrowProps = useRender.ComponentProps<'span'>

/** The small uppercase label above a card's number. */
export function Eyebrow(props: EyebrowProps) {
  const { className, render, ...rest } = props
  return useRender({
    render,
    defaultTagName: 'span',
    props: { className: clsx('m3-eyebrow', className), ...rest },
  })
}
