import { useForm } from '@tanstack/react-form'
import type { Values } from './form'

/** One form for the four steps: the values outlive a step change because
 *  `?step=` re-renders the route rather than remounting it. Exported as a
 *  hook so every step can name the form's type without naming its generics. */
export function useSessionForm(defaults: Values, onSubmit: (values: Values) => void) {
  return useForm({
    defaultValues: defaults,
    onSubmit: ({ value }) => onSubmit(value),
  })
}

export type SessionForm = ReturnType<typeof useSessionForm>
