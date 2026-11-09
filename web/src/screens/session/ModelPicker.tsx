import { Cpu } from 'lucide-react'
import { MODELS, type ClaudeModel } from '@/api/thread'
import { ChoicePicker } from './ChoicePicker'

export type ModelPickerProps = {
  value: ClaudeModel | null
  disabled?: boolean
  onChange: (model: ClaudeModel | null) => void
}

const OPTIONS = MODELS.map(({ model, label }) => ({ value: model, label }))

/** Claude's model for the next turn (Y-564): "Model: Opus". */
export function ModelPicker(props: ModelPickerProps) {
  return <ChoicePicker icon={Cpu} name="Model" options={OPTIONS} {...props} />
}
