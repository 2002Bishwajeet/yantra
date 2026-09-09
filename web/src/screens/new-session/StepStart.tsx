import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Bot, Terminal } from 'lucide-react'
import { dirsQuery } from '@/api/queries'
import { Card } from '@/m3/card/Card'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { Tile } from '@/m3/tile/Tile'
import { useFormFactor } from '@/shell/formFactor'
import { happenings, tilde, type Values } from './form'
import type { SessionForm } from './useSessionForm'

function Option(props: {
  icon: ReactNode
  eyebrow: string
  title: string
  note: string
  pressed: boolean
  disabled?: boolean
  onPress: () => void
  children?: ReactNode
}) {
  const { icon, eyebrow, title, note, pressed, disabled, onPress, children } = props
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
          <Eyebrow>{eyebrow}</Eyebrow>
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

function Recap(props: { values: Values; home: string | null }) {
  const { values, home } = props
  const { source } = values
  return (
    <Card className="ns__card" surface="low">
      <Eyebrow render={<h2 />}>So far</Eyebrow>
      <dl className="ns__recap-list">
        <div>
          <dt>Name</dt>
          <dd>
            <Tile name={values.name} size="small" /> {values.name}
          </dd>
        </div>
        <div>
          <dt>Machine</dt>
          <dd>{values.machine}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            {source?.kind === 'github' ? source.repo.full_name : source ? tilde(source.path, home) : '—'}
            {source?.kind === 'github' ? (
              <Mono className="ns__place">
                {source.here === 'no' ? `clone into ${tilde(source.path, home)}` : `already at ${tilde(source.path, home)}`}
              </Mono>
            ) : null}
          </dd>
        </div>
      </dl>
    </Card>
  )
}

/** Step 3: what opens in the session, and what will happen (NewSessionStart). */
export function StepStart(props: { form: SessionForm; values: Values }) {
  const { form, values } = props
  const factor = useFormFactor()
  const home = useQuery({ ...dirsQuery(values.machine, null), enabled: true })
  const root = home.data?.path ?? null
  return (
    <>
      {factor === 'phone' ? <Recap home={root} values={values} /> : null}
      <Card className="ns__card">
        <Eyebrow render={<h2 />}>What opens in the session</Eyebrow>
        <div aria-label="What opens in the session" className="ns__choices" role="group">
          <Option
            eyebrow="agent"
            icon={<Bot />}
            note="Claude Code opens in the repository and asks for trust before it runs anything"
            onPress={() => form.setFieldValue('opens', 'claude')}
            pressed={values.opens === 'claude'}
            title="Claude"
          />
          <Option
            eyebrow="command"
            icon={<Terminal />}
            note="for example: just dev"
            onPress={() => form.setFieldValue('opens', 'command')}
            pressed={values.opens === 'command'}
            title="A command"
          >
            <form.Field name="command">
              {(field) => (
                <TextField
                  autoComplete="off"
                  label="Command"
                  onValueChange={field.handleChange}
                  supporting="a shell command; a secret stays a reference the shell resolves, and Yantra never holds the value"
                  value={field.state.value}
                />
              )}
            </form.Field>
          </Option>
          <Option
            disabled
            eyebrow="Another agent"
            icon={<Bot />}
            note="later. Only Claude is wired today."
            onPress={() => form.setFieldValue('opens', 'later')}
            pressed={values.opens === 'later'}
            title="Another agent"
          />
        </div>
      </Card>
      <Card className="ns__card" surface="low">
        <Eyebrow render={<h2 />}>What will happen</Eyebrow>
        <ol className="ns__happen">
          {happenings(values, root).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </Card>
    </>
  )
}
