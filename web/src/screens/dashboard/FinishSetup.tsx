import { useId } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { State } from '@/m3/mark/Mark'
import { Text } from '@/m3/text/Text'
import { Track } from '@/m3/track/Track'
import { usePrefs } from '@/shell/prefs'
import { REQUIRED, useChecklist } from '@/screens/setup/progress'
import { marks, statusWord } from '@/screens/setup/steps'
import { hideSetupCard, setupCardHidden } from './setupCard'

function Unfinished(props: { now: number }) {
  const heading = useId()
  const { later, done, settled } = useChecklist(props.now)
  // Unsettled, a step says *not yet* for what is only unread.
  if (!settled) return null
  const open = [
    { key: 'github', title: 'GitHub', step: later.github, action: 'Connect', category: 'providers' },
    { key: 'push', title: 'Push to your phone', step: later.push, action: 'Set up', category: 'notifications' },
  ].filter((one) => one.step.status !== 'done')
  if (open.length === 0) return null
  const total = REQUIRED + 2
  const all = done + 2 - open.length
  return (
    <Card aria-labelledby={heading} className="dash__setup" surface="high">
      <div className="dash__setup-head">
        <Text emphasized id={heading} render={<h2 />} scale="title-large">
          Finish setup
        </Text>
        <Button aria-label="Hide Finish setup" onClick={hideSetupCard} variant="text">
          Hide
        </Button>
      </div>
      <Track className="dash__setup-track" label={`${all} of ${total} setup steps done`} value={all / total} />
      <ul className="dash__setup-list">
        {open.map((one) => (
          <li key={one.key}>
            <div className="dash__setup-text">
              <Text emphasized scale="body-medium">
                {one.title}
              </Text>
              <State size="small" state={marks[one.step.status]}>
                {statusWord[one.step.status]} · {one.step.words}
              </State>
            </div>
            <Button render={<Link params={{ category: one.category }} to="/settings/$category" />} role="link" variant="tonal">
              {one.action}
            </Button>
          </li>
        ))}
        <li>
          <Button render={<Link to="/machines/add" />} role="link" variant="text">
            Add another device
          </Button>
        </li>
      </ul>
    </Card>
  )
}

/** D7 §4.9 and the owner's ruling (b): once the checklist stops being `/`,
 *  this card holds the steps for later until they are done or it is hidden.
 *  Settings → General brings a hidden card back. */
export function FinishSetup(props: { now: number }) {
  if (setupCardHidden(usePrefs())) return null
  return <Unfinished now={props.now} />
}
