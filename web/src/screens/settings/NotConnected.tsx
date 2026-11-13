import { lazy, Suspense, useState } from 'react'
import { LogIn } from 'lucide-react'
import { REFUSED } from '@/lib/github'
import { Button } from '@/m3/button/Button'
import { State } from '@/m3/mark/Mark'
import { Row } from '@/m3/row/Row'
import { Text } from '@/m3/text/Text'
import './NotConnected.css'

// The Dashboard draws this row, and Base UI's dialog must stay out of the first load.
const ConnectSheet = lazy(() => import('./ConnectSheet').then((it) => ({ default: it.ConnectSheet })))

/** One row for a missing or refused GitHub grant, the same on every screen (Y-753).
 *  The daemon's sentence names the CLI, so it is never drawn: the sign-in is a button here. */
export function NotConnected(props: { why: string; refused?: boolean; className?: string }) {
  const { why, refused, className } = props
  const [open, setOpen] = useState(false)
  const [asked, setAsked] = useState(false)
  return (
    <Row className={className ? `not-connected ${className}` : 'not-connected'}>
      <div className="not-connected__text">
        <State state="unknown">
          <Text emphasized scale="body-medium">
            {refused ? REFUSED : 'GitHub is not connected'}
          </Text>
        </State>
        <Text render={<p />} scale="body-small" tone="variant">
          {why}
        </Text>
      </div>
      <Button icon={<LogIn />} onClick={() => {
          setAsked(true)
          setOpen(true)
        }} variant="tonal">
        {refused ? 'Sign in again' : 'Connect'}
      </Button>
      {asked ? (
        <Suspense fallback={null}>
          <ConnectSheet onOpenChange={setOpen} open={open} />
        </Suspense>
      ) : null}
    </Row>
  )
}
