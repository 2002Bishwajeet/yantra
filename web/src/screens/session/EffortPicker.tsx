/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/TraitsPicker.tsx:
 * a composer control that names the turn's reasoning effort and opens a radio menu of the levels.
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/TraitsPicker.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { Menu as Base } from '@base-ui/react/menu'
import { Brain, Check } from 'lucide-react'
import { EFFORTS, type Effort } from '@/api/thread'
import { Chevron, Control, Icon, Label } from '@/composer/Control'
import { Menu, MenuPopup, MenuTrigger } from '@/m3/menu/Menu'

export type EffortPickerProps = {
  value: Effort | null
  disabled?: boolean
  onChange: (effort: Effort | null) => void
}

// A radio value is a string, so Default, which sends no flag, needs a name of its own.
const DEFAULT = 'default'

/** Claude's effort for the next turn (Y-564): "Effort: High". */
export function EffortPicker(props: EffortPickerProps) {
  const { value, disabled, onChange } = props
  const label = EFFORTS.find((one) => one.effort === value)?.label ?? 'Default'
  return (
    <Menu>
      <MenuTrigger render={<Control aria-label={`Effort: ${label}`} disabled={disabled} />}>
        <Icon icon={Brain} />
        <Label>{label}</Label>
        <Chevron />
      </MenuTrigger>
      <MenuPopup align="start" aria-label="Effort" side="top">
        <Base.RadioGroup
          onValueChange={(picked) => onChange(picked === DEFAULT ? null : (picked as Effort))}
          value={value ?? DEFAULT}
        >
          {EFFORTS.map(({ effort, label }) => (
            <Base.RadioItem
              aria-label={label}
              className="m3-menu-item m3-interactive"
              closeOnClick
              key={label}
              value={effort ?? DEFAULT}
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
