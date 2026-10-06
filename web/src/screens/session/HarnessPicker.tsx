/*
 * The shape of this picker is T3 Code's provider picker: a composer control
 * that names the active provider, opens a menu of the others, and is locked
 * once the thread has one:
 * https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/ProviderModelPicker.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { Menu as Base } from '@base-ui/react/menu'
import { Check, ChevronDown } from 'lucide-react'
import { HARNESSES, LABEL, type Harness } from '@/api/thread'
import { Button } from '@/m3/button/Button'
import { Menu, MenuPopup, MenuTrigger } from '@/m3/menu/Menu'

export type HarnessPickerProps = {
  value: Harness
  /** The thread has a harness, and a thread keeps it. */
  locked: boolean
  disabled?: boolean
  onChange: (harness: Harness) => void
}

/** Who answers in a new chat. The name says the choice, so a reader hears
 *  "Harness: Codex" on the trigger as well as in the menu. */
export function HarnessPicker(props: HarnessPickerProps) {
  const { value, locked, disabled, onChange } = props
  const name = `Harness: ${LABEL[value]}`
  if (locked) {
    return (
      <Button aria-label={`${name}, kept by this chat`} className="chat__harness" disabled variant="text">
        {LABEL[value]}
      </Button>
    )
  }
  return (
    <Menu>
      <MenuTrigger
        render={<Button aria-label={name} className="chat__harness" disabled={disabled} variant="text" />}
      >
        {LABEL[value]}
        <ChevronDown aria-hidden="true" className="chat__harness-chevron" />
      </MenuTrigger>
      <MenuPopup align="start" aria-label="Harness" side="top">
        <Base.RadioGroup onValueChange={(picked) => onChange(picked as Harness)} value={value}>
          {HARNESSES.map((harness) => (
            <Base.RadioItem className="m3-menu-item m3-interactive" key={harness} value={harness}>
              <span className="m3-menu-item__icon" aria-hidden="true">
                <Base.RadioItemIndicator>
                  <Check />
                </Base.RadioItemIndicator>
              </span>
              {LABEL[harness]}
            </Base.RadioItem>
          ))}
        </Base.RadioGroup>
      </MenuPopup>
    </Menu>
  )
}
