/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/ProviderModelPicker.tsx:
 * a composer control that names the turn's model and opens a radio menu of them.
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/ProviderModelPicker.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { Menu as Base } from '@base-ui/react/menu'
import { Check, Cpu } from 'lucide-react'
import { MODELS, type ClaudeModel } from '@/api/thread'
import { Chevron, Control, Icon, Label } from '@/composer/Control'
import { Menu, MenuPopup, MenuTrigger } from '@/m3/menu/Menu'

export type ModelPickerProps = {
  value: ClaudeModel | null
  disabled?: boolean
  onChange: (model: ClaudeModel | null) => void
}

// A radio value is a string, so Default, which sends no flag, needs a name of its own.
const DEFAULT = 'default'

/** Claude's model for the next turn (Y-564): "Model: Opus". */
export function ModelPicker(props: ModelPickerProps) {
  const { value, disabled, onChange } = props
  const label = MODELS.find((one) => one.model === value)?.label ?? 'Default'
  return (
    <Menu>
      <MenuTrigger render={<Control aria-label={`Model: ${label}`} disabled={disabled} />}>
        <Icon icon={Cpu} />
        <Label>{label}</Label>
        <Chevron />
      </MenuTrigger>
      <MenuPopup align="start" aria-label="Model" side="top">
        <Base.RadioGroup
          onValueChange={(picked) => onChange(picked === DEFAULT ? null : (picked as ClaudeModel))}
          value={value ?? DEFAULT}
        >
          {MODELS.map(({ model, label }) => (
            <Base.RadioItem
              aria-label={label}
              className="m3-menu-item m3-interactive"
              closeOnClick
              key={label}
              value={model ?? DEFAULT}
            >
              <span className="m3-menu-item__icon" aria-hidden="true">
                <Base.RadioItemIndicator>
                  <Check />
                </Base.RadioItemIndicator>
              </span>
              <span>{label}</span>
            </Base.RadioItem>
          ))}
        </Base.RadioGroup>
      </MenuPopup>
    </Menu>
  )
}
