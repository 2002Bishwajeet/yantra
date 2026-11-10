/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/ProviderModelPicker.tsx and TraitsPicker.tsx:
 * a composer control that names the turn's choice and opens a radio menu of the options.
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/ProviderModelPicker.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { Menu as Base } from '@base-ui/react/menu'
import { Check, type LucideIcon } from 'lucide-react'
import { Chevron, Control, Icon, Label } from '@/composer/Control'
import { Menu, MenuPopup, MenuTrigger } from '@/m3/menu/Menu'

export type ChoicePickerProps<T extends string | number> = {
  name: string
  icon: LucideIcon
  options: readonly { value: T | null; label: string }[]
  value: T | null
  disabled?: boolean
  onChange: (value: T | null) => void
}

// A radio value is a string, so Default, which sends no flag, needs a name of its own,
// and a number such as a context length is matched by its text.
const DEFAULT = 'default'

/** One of Claude's settings for the next turn (Y-564): "Model: Opus". */
export function ChoicePicker<T extends string | number>(props: ChoicePickerProps<T>) {
  const { name, icon, options, value, disabled, onChange } = props
  const label = options.find((one) => one.value === value)?.label ?? 'Default'
  return (
    <Menu>
      <MenuTrigger render={<Control aria-label={`${name}: ${label}`} disabled={disabled} />}>
        <Icon icon={icon} />
        <Label>{label}</Label>
        <Chevron />
      </MenuTrigger>
      <MenuPopup align="start" aria-label={name} side="top">
        <Base.RadioGroup
          onValueChange={(picked) => onChange(options.find((one) => String(one.value ?? DEFAULT) === picked)?.value ?? null)}
          value={String(value ?? DEFAULT)}
        >
          {options.map((one) => (
            <Base.RadioItem
              aria-label={one.label}
              className="m3-menu-item m3-interactive"
              closeOnClick
              key={one.label}
              value={String(one.value ?? DEFAULT)}
            >
              <span className="m3-menu-item__icon" aria-hidden="true">
                <Base.RadioItemIndicator>
                  <Check />
                </Base.RadioItemIndicator>
              </span>
              <span>{one.label}</span>
            </Base.RadioItem>
          ))}
        </Base.RadioGroup>
      </MenuPopup>
    </Menu>
  )
}
