/*
 * The four permission modes, their names and their descriptions are T3 Code's
 * at 72d5c32, as is a composer control that names the thread's mode:
 * https://github.com/pingdotgg/t3code/blob/72d5c32ba67953805feb6fe9ad3b70b632a64c47/docs/user/permission-modes.md
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useId } from 'react'
import { Menu as Base } from '@base-ui/react/menu'
import { Check, PenLine, ShieldCheck, ShieldOff, Zap, type LucideIcon } from 'lucide-react'
import { MODES, type PermissionMode } from '@/api/thread'
import { Chevron, Control, Icon, Label } from '@/composer/Control'
import { Menu, MenuPopup, MenuTrigger } from '@/m3/menu/Menu'

export type ModePickerProps = {
  value: PermissionMode
  disabled?: boolean
  onChange: (mode: PermissionMode) => void
}

// A phone drops the words, so each mode keeps a glyph of its own: the mode is the safety setting.
const GLYPH: Record<PermissionMode, LucideIcon> = {
  supervised: ShieldCheck,
  'auto-accept-edits': PenLine,
  auto: Zap,
  'full-access': ShieldOff,
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
          <Control
            aria-label={`Permissions: ${LABEL[value]}`}
            data-tone={value === 'full-access' ? 'warning' : undefined}
            disabled={disabled}
          />
        }
      >
        <Icon icon={GLYPH[value]} />
        <Label>{LABEL[value]}</Label>
        <Chevron />
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
