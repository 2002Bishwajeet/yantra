import { lazy, Suspense, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { Kbd } from '@/m3/kbd/Kbd'
import { Pill } from '@/m3/pill/Pill'
import { matchHelp } from '@/screens/session/keys'
import { PALETTE_EVENT } from './loopCommands'

const PalettePopup = lazy(() =>
  import('./PalettePopup').then((it) => ({ default: it.PalettePopup })),
)

// The listener takes either modifier; this only says which one to press.
const SHORTCUT = navigator.userAgent.includes('Mac') ? '⌘K' : 'Ctrl K'

/** The search pill, ⌘K and `?`. The tablet and the phone draw no pill but keep the keys. The overlay arrives with the first summon, and
 *  stays mounted after it so a second press is instant. */
export function Palette(props: { pill?: boolean }) {
  const pill = props.pill ?? true
  const [armed, setArmed] = useState(false)
  const [open, setOpen] = useState(false)
  const [help, setHelp] = useState(false)
  const [seed, setSeed] = useState<{ query: string } | null>(null)

  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      if (event.key !== 'k' || !(event.metaKey || event.ctrlKey)) return
      // The terminal pane takes every key it is given, and Ctrl-K there is
      // readline's kill-to-end-of-line. `.xterm` is the pane's own mark.
      if (document.activeElement?.closest('.xterm')) return
      event.preventDefault()
      setArmed(true)
      setOpen((was) => !was)
    }
    const asked = (event: KeyboardEvent) => {
      if (!matchHelp(event)) return
      event.preventDefault()
      setArmed(true)
      setHelp(true)
    }
    // The issue chord opens the palette with its query in it.
    const seeded = (event: Event) => {
      setSeed({ query: (event as CustomEvent<string>).detail })
      setArmed(true)
      setOpen(true)
    }
    document.addEventListener('keydown', pressed)
    document.addEventListener('keydown', asked)
    document.addEventListener(PALETTE_EVENT, seeded)
    return () => {
      document.removeEventListener('keydown', pressed)
      document.removeEventListener('keydown', asked)
      document.removeEventListener(PALETTE_EVENT, seeded)
    }
  }, [])

  return (
    <>
      {pill ? (
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
      ) : null}
      {armed ? (
        <ErrorBoundary layout="inline" title="The palette could not be drawn">
          <Suspense fallback={null}>
            <PalettePopup help={help} onHelpChange={setHelp} onOpenChange={setOpen} open={open} seed={seed} />
          </Suspense>
        </ErrorBoundary>
      ) : null}
    </>
  )
}
