import { Badge } from '@/components/ui/badge'

const variants = {
  ok: 'secondary',
  warn: 'outline',
  bad: 'destructive',
  unknown: 'ghost',
} as const

export type Tone = keyof typeof variants

/** The only file that knows a colour exists. `label` is always rendered as
 *  text, so no state is carried by colour alone. */
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
    <Badge variant={variants[tone]} title={detail}>
      {label}
    </Badge>
  )
}
