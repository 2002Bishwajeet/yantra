import { RefreshCw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { fromReading } from '@/api/client'
import { useMachines } from '@/api/hooks'
import { keys } from '@/api/keys'
import { Card } from '@/m3/card/Card'
import { FilterChip } from '@/m3/chip/Chip'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { IconButton } from '@/m3/icon-button/IconButton'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Eyebrow, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { Tile } from '@/m3/tile/Tile'
import { nameError, type Values } from './form'
import type { SessionForm } from './useSessionForm'
import { generateName } from './words'

function Machines(props: { form: SessionForm; values: Values }) {
  const { form, values } = props
  const machines = useMachines()
  const client = useQueryClient()
  if (machines.looked === 'pending') {
    return (
      <div aria-busy="true" className="ns__chips">
        <Skeleton shape="text" style={{ width: 120 }} />
        <Skeleton shape="text" style={{ width: 96 }} />
        <Skeleton shape="text" style={{ width: 72 }} />
      </div>
    )
  }
  if (machines.looked !== 'ok') {
    return (
      <ErrorSurface.Inline
        error={
          fromReading(machines) ?? {
            kind: 'network',
            said: '',
            retryable: false,
            describe: () => 'The machines have not been looked at yet, so none can be chosen.',
          }
        }
        reset={() => void client.invalidateQueries({ queryKey: keys.machines() })}
        title="Machines could not be read"
      />
    )
  }
  return (
    <div aria-label="Machine" className="ns__chips" role="group">
      {machines.data.map((one) => {
        const reachable = one.online && !one.expired
        return (
          <FilterChip
            disabled={!reachable}
            key={one.name}
            onPressedChange={(pressed) => {
              if (!pressed) return
              form.setFieldValue('machine', one.name)
              // A path is a fact about one machine.
              form.setFieldValue('source', null)
            }}
            pressed={values.machine === one.name}
          >
            {reachable ? one.name : `${one.name} · unreachable`}
          </FilterChip>
        )
      })}
    </div>
  )
}

/** Step 1: the name, its tile, and the machine (NewSession, PhoneNewSessionName). */
export function StepName(props: { form: SessionForm; values: Values }) {
  const { form, values } = props
  return (
    <Card className="ns__card">
      <Eyebrow as="h2">Name</Eyebrow>
      <div className="ns__name">
        <Tile className="ns__preview" name={values.name || '?'} />
        <form.Field name="name" validators={{ onChange: ({ value }) => nameError(value) }}>
          {(field) => {
            const error = field.state.meta.errorMap.onChange
            return (
              <TextField
                autoComplete="off"
                className="ns__field"
                error={typeof error === 'string' ? error : undefined}
                label="Name"
                onBlur={field.handleBlur}
                onValueChange={(value) => {
                  field.handleChange(value)
                  form.setFieldValue('named', true)
                }}
                supporting={
                  <>
                    optional. Leave it and the session is called {values.name || 'what you type'};
                    the letter and colour are how you tell sessions apart at a glance.
                  </>
                }
                trailing={
                  <IconButton
                    label="Another name"
                    onClick={() => {
                      field.handleChange(generateName())
                      form.setFieldValue('named', false)
                    }}
                  >
                    <RefreshCw />
                  </IconButton>
                }
                value={field.state.value}
              />
            )
          }}
        </form.Field>
      </div>

      <Eyebrow as="h2">Machine</Eyebrow>
      <Machines form={form} values={values} />
      <Text as="p" className="ns__note" scale="body-medium" tone="variant">
        the session runs here; the repository is looked for on this machine in the next step.
      </Text>
    </Card>
  )
}
