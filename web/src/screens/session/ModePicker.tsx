/*
 * The four permission modes, their names and their descriptions are T3 Code's
 * at 72d5c32, as is a composer control that names the thread's mode:
 * https://github.com/pingdotgg/t3code/blob/72d5c32ba67953805feb6fe9ad3b70b632a64c47/docs/user/permission-modes.md
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useId } from 'react'
import { Menu as Base } from '@base-ui/react/menu'
import { Check, ChevronDown } from 'lucide-react'
import { MODES, type PermissionMode } from '@/api/thread'
import { Button } from '@/m3/button/Button'
import { Menu, MenuPopup, MenuTrigger } from '@/m3/menu/Menu'

export type ModePickerProps = {
  value: PermissionMode
  disabled?: boolean
  onChange: (mode: PermissionMode) => void
}

const LABEL = Object.fromEntries(MODES.map((one) => [one.mode, one.label])) as Record<PermissionMode, string>

/** When the agent asks first (Y-453). A change holds from the next turn, so
 *  the trigger names the mode: "Permissions: Supervised". */
export function ModePicker(props: ModePickerProps) {
  const { value, disabled, onChange } = props
  const id = useId()
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={`Permissions: ${LABEL[value]}`}
            className="chat__harness"
            disabled={disabled}
            variant="text"
          />
        }
      >
        {LABEL[value]}
        <ChevronDown aria-hidden="true" className="chat__harness-chevron" />
      </MenuTrigger>
      <MenuPopup align="start" aria-label="Permissions" side="top">
        <Base.RadioGroup onValueChange={(picked) => onChange(picked as PermissionMode)} value={value}>
          {MODES.map(({ mode, label, description }) => (
            <Base.RadioItem
              aria-describedby={`${id}-${mode}`}
              aria-label={label}
              className="m3-menu-item m3-interactive chat__mode"
              closeOnClick
              key={mode}
              value={mode}
            >
              <span className="m3-menu-item__icon" aria-hidden="true">
                <Base.RadioItemIndicator>
                  <Check />
                </Base.RadioItemIndicator>
              </span>
              <span className="chat__mode-text">
                <span>{label}</span>
                <span className="chat__mode-description" id={`${id}-${mode}`}>
                  {description}
                </span>
              </span>
            </Base.RadioItem>
          ))}
        </Base.RadioGroup>
      </MenuPopup>
    </Menu>
  )
}
