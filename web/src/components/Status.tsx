import { Badge } from '@/components/ui/badge'

const variants = {
  ok: 'secondary',
  warn: 'outline',
  bad: 'destructive',
  idle: 'outline',
  unknown: 'ghost',
} as const

/** D3 §6.1's four marks, two of which two tones share: *needs you* is what a
 *  crash and a trust prompt have in common, and they differ in colour alone.
 *  The shapes are `index.css`'s, so no colour is named here (ADR-0014). */
const marks = {
  ok: 'mark tone-ok',
  warn: 'mark tone-warn',
  bad: 'mark tone-bad',
  idle: 'mark tone-idle',
  unknown: 'mark tone-unknown',
} as const

export type Tone = keyof typeof variants

/** The only file that knows a colour exists. `label` is always rendered as
 *  text, and the mark repeats the state in form, so no state is carried by
 *  colour alone. */
export function Status({
  tone,
  label,
  detail,
}: {
  tone: Tone
  label: string
  detail?: string
}) {
  return (
    <Badge className={marks[tone]} variant={variants[tone]} title={detail}>
      {label}
    </Badge>
  )
}
