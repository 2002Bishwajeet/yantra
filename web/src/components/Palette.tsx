import { lazy, Suspense, useEffect, useState } from 'react'
import { SearchIcon } from 'lucide-react'
import type { Listed, Machine } from '@/api'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { loaded, useLooked } from '@/useLooked'

const PalettePopup = lazy(() =>
  import('@/components/PalettePopup').then((it) => ({
    default: it.PalettePopup,
  })),
)

// The listener takes either modifier; this only says which one to press.
const SHORTCUT = navigator.userAgent.includes('Mac') ? '⌘K' : 'Ctrl K'

/** The half of the palette that has to be there before anyone asks for it: the
 *  shortcut, the control a phone can tap, and the two readings the pages already
 *  take under the same keys — so the palette shares their cache rather than
 *  polling a third copy. The overlay itself arrives on the first summon. */
export function Palette() {
  // Two flags rather than one: `armed` is what fetches the overlay's chunk and
  // never unsets, `open` is what the palette itself is doing.
  const [armed, setArmed] = useState(false)
  const [open, setOpen] = useState(false)
  const workspaces = loaded(useLooked<Listed[]>('/api/workspaces'))
  const machines = useLooked<Machine[]>('/api/machines')

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
      {/* D3 §10: a phone has no ⌘K, so the shortcut is a hint on a control that
          can be tapped rather than the only way in. It says what it opens
          itself, since `CommandDialogTrigger` lives in the chunk it opens. */}
      <Button
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setArmed(true)
          setOpen(true)
        }}
        size="sm"
        variant="outline"
      >
        <SearchIcon />
        Search
        <Kbd className="max-sm:hidden">{SHORTCUT}</Kbd>
      </Button>

      {armed && (
        <Suspense fallback={null}>
          <PalettePopup
            machines={machines}
            onOpenChange={setOpen}
            open={open}
            workspaces={workspaces}
          />
        </Suspense>
      )}
    </>
  )
}
