import { Select as Base } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import './Select.css'

export type SelectOption = { value: string; label: string }

export type SelectProps = {
  /** The accessible name; the trigger shows the value, not this. */
  label: string
  value: string
  options: SelectOption[]
  onValueChange: (value: string) => void
  dense?: boolean
  className?: string
}

/** The exposed dropdown menu: an outlined field that opens an m3-menu. */
export function Select({ label, value, options, onValueChange, dense, className }: SelectProps) {
  return (
    <Base.Root
      items={options}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next)
      }}
      value={value}
    >
      <Base.Trigger aria-label={label} className={clsx('m3-select', 'm3-interactive', className)} data-dense={dense ? '' : undefined}>
        <Base.Value className="m3-select__value" />
        <Base.Icon className="m3-select__icon">
          <ChevronDown aria-hidden="true" />
        </Base.Icon>
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner alignItemWithTrigger={false} className="m3-select__positioner" sideOffset={4}>
          <Base.Popup className="m3-select__popup">
            <Base.List className="m3-select__list">
              {options.map((one) => (
                <Base.Item className="m3-select__item m3-interactive" key={one.value} value={one.value}>
                  <Base.ItemText className="m3-select__text">{one.label}</Base.ItemText>
                  <Base.ItemIndicator className="m3-select__check">
                    <Check aria-hidden="true" />
                  </Base.ItemIndicator>
                </Base.Item>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
