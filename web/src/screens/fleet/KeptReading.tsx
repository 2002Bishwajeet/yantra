import type { Reading } from '@/api/hooks'
import { State } from '@/m3/mark/Mark'
import { Text } from '@/m3/text/Text'
import { Ago } from './age'
import './KeptReading.css'

/** Y-745: the daemon kept this GitHub reading through one read that failed.
 *  Only the first line is a live region: the age under it changes on every poll. */
export function KeptReading(props: { reading: Reading<unknown> }) {
  const { reading } = props
  if (reading.looked !== 'ok' || !reading.retrying) return null
  return (
    <div className="kept">
      <State role="status" state="unknown">
        <Text scale="label-large">The last GitHub read failed</Text>
      </State>
      <Text render={<p />} className="kept__why" scale="body-small">
        Showing what it said <Ago seconds={reading.age_seconds} /> ago · {reading.retrying}
      </Text>
    </div>
  )
}
