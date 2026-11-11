/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/TraitsPicker.tsx:
 * one composer control that opens the turn's traits. The four permission modes and their words are
 * T3 Code's, at 72d5c32.
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/TraitsPicker.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useId, useState, type ReactNode } from 'react'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Check, SlidersHorizontal } from 'lucide-react'
import {
  DEFAULT_MODE,
  EFFORTS,
  MODELS,
  MODES,
  type ClaudeModel,
  type ContextLength,
  type Effort,
  type PermissionMode,
} from '@/api/thread'
import { Control, Icon, Label } from '@/composer/Control'
import { BottomSheet, BottomSheetPopup, BottomSheetTrigger } from '@/m3/bottom-sheet/BottomSheet'
import { Popover, PopoverPopup, PopoverTrigger } from '@/m3/popover/Popover'
import { Text } from '@/m3/text/Text'
import { useFormFactor } from '@/shell/formFactor'
import './TurnSettings.css'

export type TurnSettingsProps = {
  mode: PermissionMode
  onMode: (mode: PermissionMode) => void
  /** Claude's model and effort; any other harness takes neither, and the groups are not drawn. */
  claude: boolean
  model: ClaudeModel | null
  onModel: (model: ClaudeModel | null) => void
  effort: Effort | null
  onEffort: (effort: Effort | null) => void
  /** The lengths the model allows, from `lengthsFor`; none draws no group. */
  lengths: readonly { length: ContextLength | null; label: string }[]
  context: ContextLength | null
  onContext: (length: ContextLength | null) => void
  /** Codex reads its length only when its keeper starts. */
  contextLocked?: boolean
  disabled?: boolean
}

// A radio value is a string, so Default, which sends no flag, needs a name of its own.
const DEFAULT = 'default'

type Option<T> = { value: T | null; label: string; description?: string }

function Group<T extends string | number>(props: {
  name: string
  options: readonly Option<T>[]
  value: T | null
  onChange: (value: T | null) => void
  disabled?: boolean
}) {
  const { name, options, value, onChange, disabled } = props
  const id = useId()
  return (
    <div className="turn-settings__group">
      <Text id={id} scale="label-medium" tone="variant">
        {name}
      </Text>
      <RadioGroup
        aria-labelledby={id}
        className="turn-settings__options"
        disabled={disabled}
        onValueChange={(picked) => onChange(options.find((one) => String(one.value ?? DEFAULT) === picked)?.value ?? null)}
        value={String(value ?? DEFAULT)}
      >
        {options.map((one) => (
          <Radio.Root
            aria-describedby={one.description ? `${id}-${one.label}` : undefined}
            aria-label={one.label}
            className="turn-settings__option m3-interactive"
            key={one.label}
            value={String(one.value ?? DEFAULT)}
          >
            <span aria-hidden="true" className="turn-settings__check">
              <Radio.Indicator keepMounted={false}>
                <Check />
              </Radio.Indicator>
            </span>
            <span className="turn-settings__text">
              <span>{one.label}</span>
              {one.description ? (
                <span className="turn-settings__description" id={`${id}-${one.label}`}>
                  {one.description}
                </span>
              ) : null}
            </span>
          </Radio.Root>
        ))}
      </RadioGroup>
    </div>
  )
}

const MODEL_OPTIONS = MODELS.map(({ model, label }) => ({ value: model, label }))
const EFFORT_OPTIONS = EFFORTS.map(({ effort, label }) => ({ value: effort, label }))
const MODE_OPTIONS = MODES.map(({ mode, label, description }) => ({ value: mode, label, description }))

const labelOf = <T,>(options: readonly Option<T>[], value: T | null) =>
  options.find((one) => one.value === value)?.label ?? 'Default'

/** Y-717: permissions, model, effort and context length in one chip. The chip names only what is not the
 *  default; an aria-label names all of it. A popover on a desktop or a tablet, a bottom sheet on a phone. */
export function TurnSettings(props: TurnSettingsProps) {
  const { mode, claude, model, effort, lengths, context, contextLocked, disabled } = props
  const factor = useFormFactor()
  const [open, setOpen] = useState(false)
  const contextOptions = lengths.map(({ length, label }) => ({ value: length, label }))

  const changed = [
    mode === DEFAULT_MODE ? null : labelOf(MODE_OPTIONS, mode),
    claude && model !== null ? labelOf(MODEL_OPTIONS, model) : null,
    claude && effort !== null ? labelOf(EFFORT_OPTIONS, effort) : null,
    lengths.length > 0 && context !== null ? labelOf(contextOptions, context) : null,
  ].filter((one) => one !== null)
  const said = [
    labelOf(MODE_OPTIONS, mode),
    ...(claude ? [`model ${labelOf(MODEL_OPTIONS, model)}`, `effort ${labelOf(EFFORT_OPTIONS, effort)}`] : []),
    ...(lengths.length > 0 ? [`context ${labelOf(contextOptions, context)}`] : []),
  ]

  const trigger = (
    <Control
      aria-label={`Turn settings: ${said.join(', ')}`}
      data-tone={mode === 'full-access' ? 'warning' : undefined}
      disabled={disabled}
    />
  )
  const face: ReactNode = (
    <>
      <Icon icon={SlidersHorizontal} />
      {changed.length > 0 ? <Label>{changed.join(' · ')}</Label> : null}
    </>
  )
  const groups = (
    <div className="turn-settings">
      <Group name="Permissions" onChange={(next) => props.onMode(next ?? DEFAULT_MODE)} options={MODE_OPTIONS} value={mode} />
      {claude ? (
        <>
          <Group name="Model" onChange={props.onModel} options={MODEL_OPTIONS} value={model} />
          <Group name="Effort" onChange={props.onEffort} options={EFFORT_OPTIONS} value={effort} />
        </>
      ) : null}
      {lengths.length > 0 ? (
        <Group
          disabled={contextLocked}
          name="Context"
          onChange={props.onContext}
          options={contextOptions}
          value={context}
        />
      ) : null}
    </div>
  )

  if (factor === 'phone') {
    return (
      <BottomSheet onOpenChange={setOpen} open={open}>
        <BottomSheetTrigger render={trigger}>{face}</BottomSheetTrigger>
        <BottomSheetPopup className="turn-settings__sheet" title="Turn settings">
          {groups}
        </BottomSheetPopup>
      </BottomSheet>
    )
  }
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger render={trigger}>{face}</PopoverTrigger>
      <PopoverPopup align="start" side="top" title="Turn settings">
        {groups}
      </PopoverPopup>
    </Popover>
  )
}
