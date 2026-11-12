import { clsx } from 'clsx'
import { Info } from 'lucide-react'
import type { Reading } from '@/api/hooks'
import { Popover, PopoverPopup, PopoverTrigger } from '@/m3/popover/Popover'
import { Text } from '@/m3/text/Text'
import { Ago } from './age'
import './KeptReading.css'

/** Y-745: the daemon kept this GitHub reading through one read that failed.
 *  One failed read is not a failure, so the mark is an age and no live region.
 *  The reason is one press away. */
export function KeptReading(props: { reading: Reading<unknown>; className?: string }) {
  const { reading, className } = props
  if (reading.looked !== 'ok' || !reading.retrying) return null
  return (
    <Popover>
      <PopoverTrigger className={clsx('kept m3-interactive m3-num', className)}>
        <span>
          as of <Ago plain seconds={reading.age_seconds} /> · retrying
        </span>
        <Info aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup align="start" className="kept__why" showTitle title="The last GitHub read failed">
        <Text render={<p />} scale="body-medium">
          {reading.retrying}
        </Text>
        <Text render={<p />} scale="body-medium" tone="variant">
          Yantra shows the reading before it and reads GitHub again.
        </Text>
      </PopoverPopup>
    </Popover>
  )
}
