import type { ReactNode } from 'react'
import { Bot, Terminal } from 'lucide-react'
import { Card } from '@/m3/card/Card'
import { Eyebrow, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { next, type Values } from './form'
import type { SessionForm } from './useSessionForm'

function Option(props: {
  icon: ReactNode
  title: string
  note: string
  pressed: boolean
  disabled?: boolean
  onPress: () => void
  children?: ReactNode
}) {
  const { icon, title, note, pressed, disabled, onPress, children } = props
  return (
    <div className="ns__option" data-pressed={pressed ? '' : undefined}>
      <button
        aria-pressed={pressed}
        className="ns__choice m3-interactive"
        disabled={disabled}
        onClick={onPress}
        type="button"
      >
        <span aria-hidden="true" className="ns__choice-icon">
          {icon}
        </span>
        <span className="ns__choice-text">
          <Text emphasized scale="title-medium">
            {title}
          </Text>
          <Text scale="body-small" tone="variant">
            {note}
          </Text>
        </span>
      </button>
      {pressed ? children : null}
    </div>
  )
}

/** Step 3: what opens in the session (NewSessionStart). */
export function StepStart(props: { form: SessionForm; values: Values }) {
  const { form, values } = props
  const first = next(values)
  return (
    <Card className="ns__card">
      <Eyebrow render={<h2 />}>What opens in the session</Eyebrow>
      <div aria-label="What opens in the session" className="ns__choices" role="group">
        <Option
          icon={<Bot />}
          note="Claude Code starts in this folder."
          onPress={() => form.setFieldValue('opens', 'claude')}
          pressed={values.opens === 'claude'}
          title="Claude"
        />
        <Option
          icon={<Terminal />}
          note="Runs one command here, such as just dev."
          onPress={() => form.setFieldValue('opens', 'command')}
          pressed={values.opens === 'command'}
          title="Your command"
        >
          <form.Field name="command">
            {(field) => (
              <TextField
                autoComplete="off"
                label="Command"
                onValueChange={field.handleChange}
                supporting="A secret stays a reference; Yantra never holds it."
                value={field.state.value}
              />
            )}
          </form.Field>
        </Option>
      </div>
      {first ? (
        <Text render={<p />} className="ns__note" scale="body-medium" tone="variant">
          {first}
        </Text>
      ) : null}
    </Card>
)
}
