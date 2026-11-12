import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { Info } from 'lucide-react'
import type { Reading } from '@/api/hooks'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { Ago } from './age'
import './KeptReading.css'

// The Dashboard draws this mark, and Base UI's popover must stay out of the
// first load. The popover's chunk loads with the mark (Y-375).
const loadWhy = () => import('./KeptReadingWhy')
const Why = lazy(() => loadWhy().then((it) => ({ default: it.KeptReadingWhy })))

/** Y-745: the daemon kept this GitHub reading through one read that failed.
 *  One failed read is not a failure, so the mark is an age and no live region.
 *  The reason is one press away. */
export function KeptReading(props: { reading: Reading<unknown>; className?: string }) {
  const { reading, className } = props
  if (reading.looked !== 'ok' || !reading.retrying) return null
  return <Mark className={className} reason={reading.retrying} seconds={reading.age_seconds} />
}

function Mark(props: { seconds: number; reason: string; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [armed, setArmed] = useState(false)
  const [open, setOpen] = useState(false)
  // React holds a lazy Suspense reveal back for 300 ms, so a popup first mounted
  // by the press opens late. Mount it closed when its chunk is in.
  useEffect(() => {
    void loadWhy().then(() => setArmed(true), () => {})
  }, [])
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className={clsx('kept m3-interactive m3-num', props.className)}
        onClick={() => {
          setArmed(true)
          setOpen((it) => !it)
        }}
        ref={ref}
        type="button"
      >
        <span>
          as of <Ago plain seconds={props.seconds} /> · retrying
        </span>
        <Info aria-hidden="true" />
      </button>
      {armed ? (
        <ErrorBoundary layout="inline" title="The reason could not be drawn">
          <Suspense fallback={null}>
            <Why anchor={ref} onOpenChange={setOpen} open={open} reason={props.reason} />
          </Suspense>
        </ErrorBoundary>
      ) : null}
    </>
  )
}
