import { useState } from 'react'
import { LogIn } from 'lucide-react'
import { REFUSED } from '@/lib/github'
import { Button } from '@/m3/button/Button'
import { State } from '@/m3/mark/Mark'
import { Row } from '@/m3/row/Row'
import { Text } from '@/m3/text/Text'
import { ConnectSheet } from './ConnectSheet'
import './NotConnected.css'

/** One row for a missing or refused GitHub grant, the same on every screen (Y-753).
 *  The daemon's sentence names the CLI, so it is never drawn: the sign-in is a button here. */
export function NotConnected(props: { why: string; refused?: boolean; className?: string }) {
  const { why, refused, className } = props
  const [open, setOpen] = useState(false)
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
      <Button icon={<LogIn />} onClick={() => setOpen(true)} variant="tonal">
        {refused ? 'Sign in again' : 'Connect'}
      </Button>
      <ConnectSheet onOpenChange={setOpen} open={open} />
    </Row>
  )
}
