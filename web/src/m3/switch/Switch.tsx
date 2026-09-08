import { Switch as Base } from '@base-ui/react/switch'
import { Check } from 'lucide-react'
import { clsx } from 'clsx'
import './Switch.css'

export type SwitchProps = Base.Root.Props & {
  /** The accessible name. Required, as it is on `IconButton` and `Fab`. */
  label: string
}

/** M3's 52 × 32 switch on Base UI: the thumb grows and takes a check when on. */
export function Switch(props: SwitchProps) {
  const { label, className, ...rest } = props
  return (
    <Base.Root
      className={clsx('m3-switch', 'm3-interactive', className)}
      aria-label={label}
      nativeButton
      render={<button type="button" />}
      {...rest}
    >
      <Base.Thumb className="m3-switch__thumb">
        <Check className="m3-switch__check" aria-hidden="true" />
      </Base.Thumb>
    </Base.Root>
  )
}
