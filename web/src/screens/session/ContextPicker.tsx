import { Gauge } from 'lucide-react'
import type { ContextLength } from '@/api/thread'
import { ChoicePicker } from './ChoicePicker'

export type ContextPickerProps = {
  /** The lengths the model allows, from `lengthsFor`. */
  lengths: readonly { length: ContextLength | null; label: string }[]
  value: ContextLength | null
  disabled?: boolean
  onChange: (length: ContextLength | null) => void
}

/** The tokens the thread fills before it compacts (Y-663): "Context: 400K". */
export function ContextPicker({ lengths, ...props }: ContextPickerProps) {
  const options = lengths.map(({ length, label }) => ({ value: length, label }))
  return <ChoicePicker icon={Gauge} name="Context" options={options} {...props} />
}
