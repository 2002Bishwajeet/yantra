import { Brain } from 'lucide-react'
import { EFFORTS, type Effort } from '@/api/thread'
import { ChoicePicker } from './ChoicePicker'

export type EffortPickerProps = {
  value: Effort | null
  disabled?: boolean
  onChange: (effort: Effort | null) => void
}

const OPTIONS = EFFORTS.map(({ effort, label }) => ({ value: effort, label }))

/** Claude's effort for the next turn (Y-564): "Effort: High". */
export function EffortPicker(props: EffortPickerProps) {
  return <ChoicePicker icon={Brain} name="Effort" options={OPTIONS} {...props} />
}
