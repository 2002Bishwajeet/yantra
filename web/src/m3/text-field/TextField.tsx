import type { ReactNode } from 'react'
import { Field } from '@base-ui/react/field'
import { clsx } from 'clsx'
import './TextField.css'

export type TextFieldProps = Field.Control.Props & {
  label: string
  variant?: 'outlined' | 'filled'
  /** The line under the field. */
  supporting?: ReactNode
  /** An error sentence; it replaces the supporting line and marks the field. */
  error?: string
  /** A leading icon, or a trailing IconButton (clear, show). */
  leading?: ReactNode
  trailing?: ReactNode
}

/** M3's 56 px text field on Base UI's Field: the label floats over the input
 *  and the error line is wired to it. */
export function TextField(props: TextFieldProps) {
  const { label, variant, supporting, error, leading, trailing, className, ...rest } = props
  return (
    <Field.Root
      className={clsx('m3-text-field', className)}
      data-variant={variant ?? 'outlined'}
      invalid={error ? true : undefined}
    >
      <div className="m3-text-field__box">
        {leading ? <span className="m3-text-field__leading">{leading}</span> : null}
        <Field.Control className="m3-text-field__input" placeholder=" " {...rest} />
        <Field.Label className="m3-text-field__label">{label}</Field.Label>
        {trailing ? <span className="m3-text-field__trailing">{trailing}</span> : null}
      </div>
      {error ? (
        <Field.Error className="m3-text-field__line" match>
          {error}
        </Field.Error>
      ) : supporting ? (
        <Field.Description className="m3-text-field__line">{supporting}</Field.Description>
      ) : null}
    </Field.Root>
  )
}
