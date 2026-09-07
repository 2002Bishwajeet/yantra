import { lazy, Suspense, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { Kbd } from '@/m3/kbd/Kbd'
import { Pill } from '@/m3/pill/Pill'

const PalettePopup = lazy(() =>
  import('./PalettePopup').then((it) => ({ default: it.PalettePopup })),
)

// The listener takes either modifier; this only says which one to press.
const SHORTCUT = navigator.userAgent.includes('Mac') ? '⌘K' : 'Ctrl K'

/** The search pill and ⌘K. The overlay arrives with the first summon, and
 *  stays mounted after it so a second press is instant. */
export function Palette() {
  const [armed, setArmed] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      if (event.key !== 'k' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      setArmed(true)
      setOpen((was) => !was)
    }
    document.addEventListener('keydown', pressed)
    return () => document.removeEventListener('keydown', pressed)
  }, [])

  return (
    <>
      <Pill
        aria-expanded={open}
        aria-haspopup="dialog"
        // Not a toggle: Pill writes aria-pressed for a filter, and this opens
        // a dialog.
        aria-pressed={undefined}
        className="shell__search"
        icon={<Search />}
        onClick={() => {
          setArmed(true)
          setOpen(true)
        }}
      >
        Search anything
        <Kbd>{SHORTCUT}</Kbd>
      </Pill>
      {armed ? (
        <ErrorBoundary layout="inline" title="The palette could not be drawn">
          <Suspense fallback={null}>
            <PalettePopup onOpenChange={setOpen} open={open} />
          </Suspense>
        </ErrorBoundary>
      ) : null}
    </>
  )
}
