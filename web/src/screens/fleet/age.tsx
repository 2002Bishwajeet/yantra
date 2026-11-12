import type { Reading } from '@/api/hooks'
import { ago } from '@/lib/time'
import { Num } from '@/m3/text/Text'
import { useTick } from '@/useTick'
import { elapsed, isAge, oldest } from './clock'

/** An age the daemon already counted, with the instant in `title`. */
export function Ago(props: { seconds: number; className?: string; plain?: boolean }) {
  const { seconds, className, plain } = props
  const clock = ago(seconds)
  const face = plain ? className : className ? `m3-num ${className}` : 'm3-num'
  return (
    <time className={face} dateTime={clock.iso} title={clock.title}>
      {clock.text}
    </time>
  )
}

/** How long since an epoch second, moved once a second — a clock, not a read. */
export function Since(props: { at: number; className?: string; plain?: boolean }) {
  const { at, className, plain } = props
  const now = useTick(true)
  const age = elapsed(now / 1000 - at)
  return plain ? <span className={className}>{age}</span> : <Num className={className}>{age}</Num>
}

/** The boards' `opened 3d ago` beside their `opened 9 Jun`, so the caller
 *  never writes the word itself. */
export function SinceAgo(props: { at: number }) {
  const now = useTick(true)
  const seconds = now / 1000 - props.at
  return (
    <>
      <Num>{elapsed(seconds)}</Num>
      {isAge(seconds) ? ' ago' : null}
    </>
  )
}

/** The boards' `looked 4s ago` beside a title. */
export function Looked(props: { reads: Reading<unknown>[]; className?: string; plain?: boolean }) {
  const { reads, className, plain } = props
  const age = oldest(reads)
  if (age === null) return null
  const body = (
    <>
      looked <Ago plain={plain} seconds={age} />
      {isAge(age) ? ' ago' : null}
    </>
  )
  return plain ? (
    <span className={className} data-slot="looked">
      {body}
    </span>
  ) : (
    <Num className={className} data-slot="looked">
      {body}
    </Num>
  )
}
