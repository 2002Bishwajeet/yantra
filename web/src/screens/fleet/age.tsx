import type { Reading } from '@/api/hooks'
import { ago } from '@/lib/time'
import { Mono } from '@/m3/text/Text'
import { useTick } from '@/useTick'
import { elapsed, isAge, oldest } from './clock'

/** An age the daemon already counted, in mono with the instant in `title`. */
export function Ago(props: { seconds: number; className?: string }) {
  const { seconds, className } = props
  const clock = ago(seconds)
  return (
    <time className={className ? `m3-mono ${className}` : 'm3-mono'} dateTime={clock.iso} title={clock.title}>
      {clock.text}
    </time>
  )
}

/** How long since an epoch second, moved once a second — a clock, not a read. */
export function Since(props: { at: number; className?: string }) {
  const { at, className } = props
  const now = useTick(true)
  return <Mono className={className}>{elapsed(now / 1000 - at)}</Mono>
}

/** The boards' `opened 3d ago` beside their `opened 9 Jun`, so the caller
 *  never writes the word itself. */
export function SinceAgo(props: { at: number }) {
  const now = useTick(true)
  const seconds = now / 1000 - props.at
  return (
    <>
      <Mono>{elapsed(seconds)}</Mono>
      {isAge(seconds) ? ' ago' : null}
    </>
  )
}

/** The boards' `looked 4s ago` beside a title. */
export function Looked(props: { reads: Reading<unknown>[]; className?: string }) {
  const { reads, className } = props
  const age = oldest(reads)
  if (age === null) return null
  return (
    <Mono className={className} data-slot="looked">
      looked <Ago seconds={age} />
      {isAge(age) ? ' ago' : null}
    </Mono>
  )
}
