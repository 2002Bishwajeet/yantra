import { useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Text } from '@/m3/text/Text'
import { dismiss, dismissed, STEPS, useChecklist } from '@/screens/setup/progress'

const left = {
  tailnet: 'the tailnet',
  ssh: 'the ssh key',
  machines: 'a ready machine',
  github: 'GitHub',
  push: 'push to your phone',
  first: 'your first session',
} as const

const joined = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

function Unfinished(props: { now: number; onDismiss: () => void }) {
  const { now, onDismiss } = props
  const heading = useId()
  const { steps, done, settled } = useChecklist(now)
  // Unsettled, the steps say *not yet* for what is only unread.
  if (!settled || done === STEPS) return null
  const open = (Object.keys(steps) as (keyof typeof steps)[])
    .filter((one) => steps[one].status !== 'done')
    .map((one) => left[one])
  return (
    <Card aria-labelledby={heading} className="dash__setup">
      <div className="dash__setup-text">
        <Text emphasized id={heading} render={<h2 />} scale="title-medium">
          Finish setup
        </Text>
        <Text scale="body-medium" tone="variant">
          {done} of {STEPS} done · {joined(open)} left
        </Text>
      </div>
      <div className="dash__setup-actions">
        <Button render={<Link to="/setup" />} role="link" variant="tonal">
          Open the checklist
        </Button>
        <Button aria-label="Dismiss Finish setup" onClick={onDismiss} variant="text">
          Dismiss
        </Button>
      </div>
    </Card>
  )
}

/** The owner's ruling (b), 2026-09-13: once the checklist stops being `/`, a
 *  small card says what is left, until it is done or dismissed. */
export function FinishSetup(props: { now: number }) {
  const [gone, setGone] = useState(dismissed)
  if (gone) return null
  return (
    <Unfinished
      now={props.now}
      onDismiss={() => {
        dismiss()
        setGone(true)
      }}
    />
  )
}
