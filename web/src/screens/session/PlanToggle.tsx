/*
 * Adapted from T3 Code at 72d5c32, apps/web/src/components/chat/ChatComposer.tsx
 * (the composer's interaction-mode toggle: its glyphs, its words and its tooltips).
 * https://github.com/pingdotgg/t3code/blob/72d5c32ba67953805feb6fe9ad3b70b632a64c47/apps/web/src/components/chat/ChatComposer.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { Bot, PencilRuler } from 'lucide-react'
import type { Interaction } from '@/api/thread'
import { Control, Icon, Label } from '@/composer/Control'

export type PlanToggleProps = {
  value: Interaction
  /** Why it cannot be pressed, shown as its title; absent, it can. */
  disabled?: string
  onChange: (interaction: Interaction) => void
}

/** Build or Plan for the next turn (Y-565). A plan turn reads and proposes, and writes nothing. */
export function PlanToggle(props: PlanToggleProps) {
  const { value, disabled, onChange } = props
  const plan = value === 'plan'
  return (
    <Control
      aria-label={plan ? 'Plan' : 'Build'}
      aria-pressed={plan}
      disabled={disabled !== undefined}
      onClick={() => onChange(plan ? 'build' : 'plan')}
      title={disabled ?? (plan ? 'Plan mode — click to return to build mode' : 'Build mode — click to enter plan mode')}
    >
      <Icon icon={plan ? PencilRuler : Bot} />
      <Label>{plan ? 'Plan' : 'Build'}</Label>
    </Control>
  )
}
