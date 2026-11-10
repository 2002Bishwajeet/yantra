/*
 * Adapted from T3 Code, apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx
 * (the agent's question answered at the composer, one question at a time).
 * https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useId, useState } from 'react'
import { ChatError } from '@/api/chat'
import type { Decision, RequestOpened } from '@/api/thread'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Eyebrow, Text } from '@/m3/text/Text'
import { useAnswer } from './useAnswer'

/** The agent's `AskUserQuestion`. The last step sends the labels chosen for each question text. */
export function PendingQuestion(props: {
  request: RequestOpened
  agent: string
  error: ChatError | null
  onAnswer: (decision: Decision, answers?: Record<string, string[]>) => boolean
  more?: number
}) {
  const { request, agent, error, onAnswer, more } = props
  const { disabled, refused, answer } = useAnswer(error, onAnswer)
  const questions = request.questions ?? []
  const [step, setStep] = useState(0)
  const [chosen, setChosen] = useState<string[][]>(() => questions.map(() => []))
  const name = useId()
  const current = questions[step]
  const picked = chosen[step] ?? []
  const last = step === questions.length - 1

  const toggle = (label: string) =>
    setChosen((now) =>
      now.map((labels, at) =>
        at !== step
          ? labels
          : current?.multiSelect
            ? labels.includes(label)
              ? labels.filter((one) => one !== label)
              : [...labels, label]
            : [label],
      ),
    )
  const submit = () =>
    answer('accept', Object.fromEntries(questions.map((one, at) => [one.question, chosen[at] ?? []])))

  return (
    <section aria-label="Waiting for your answer" className="pending">
      <div className="pending__head">
        <Eyebrow>{`${agent} asks a question`}</Eyebrow>
        {more ? <Text scale="body-small">{`${more} more waiting`}</Text> : null}
      </div>
      {current ? (
        <fieldset className="pending__question" disabled={disabled}>
          <legend>
            <Text scale="label-large">{current.header}</Text>
            {questions.length > 1 ? <Text scale="body-small">{` ${step + 1} of ${questions.length}`}</Text> : null}
          </legend>
          <Text render={<p />} scale="title-medium">
            {current.question}
          </Text>
          <div className="pending__options">
            {current.options.map((option) => (
              <label className="pending__option" key={option.label}>
                <input
                  checked={picked.includes(option.label)}
                  name={`${name}-${step}`}
                  onChange={() => toggle(option.label)}
                  type={current.multiSelect ? 'checkbox' : 'radio'}
                />
                <span className="pending__option-text">
                  <span>{option.label}</span>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {refused ? <ErrorSurface.Inline error={refused} title="The answer was not sent" /> : null}
      <div className="pending__actions">
        <Button disabled={disabled} onClick={() => answer('decline')} variant="outlined">
          Decline
        </Button>
        {step > 0 ? (
          <Button disabled={disabled} onClick={() => setStep(step - 1)} variant="text">
            Back
          </Button>
        ) : null}
        {last ? (
          <Button disabled={disabled || picked.length === 0} onClick={submit}>
            Submit
          </Button>
        ) : (
          <Button disabled={disabled || picked.length === 0} onClick={() => setStep(step + 1)}>
            Next
          </Button>
        )}
      </div>
    </section>
  )
}
