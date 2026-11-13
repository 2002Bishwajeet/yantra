import { useRef, type ComponentPropsWithRef, type ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { ArrowLeft, Search, X } from 'lucide-react'
import { IconButton } from '../icon-button/IconButton'
import './SearchView.css'

export type SearchViewProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenChangeComplete?: (open: boolean) => void
  finalFocus?: Dialog.Popup.Props['finalFocus']
  value: string
  onValueChange: (value: string) => void
  /** The combobox wiring: role, aria-controls, aria-activedescendant, keys. */
  input: Omit<ComponentPropsWithRef<'input'>, 'value' | 'onChange' | 'type'>
  /** The results; this slot scrolls inside the view. */
  children: ReactNode
}

/** The M3 search view: docked under 1240 px wide and up from 600, full screen
 *  below 600. The header is the input; a phone gets a back arrow in its place
 *  of the search icon. */
export function SearchView(props: SearchViewProps) {
  const { open, onOpenChange, onOpenChangeComplete, finalFocus, value, onValueChange, input, children } = props
  const field = useRef<HTMLInputElement>(null)
  return (
    <Dialog.Root onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete} open={open}>
      <Dialog.Portal>
        <Dialog.Backdrop className="m3-scrim m3-search__scrim" />
        <Dialog.Viewport className="m3-search__viewport">
          <Dialog.Popup className="m3-search" finalFocus={finalFocus}>
            <Dialog.Title className="m3-sr-only">Search</Dialog.Title>
            <div className="m3-search__bar">
              <Dialog.Close
                render={<IconButton className="m3-search__back" label="Close search" />}
              >
                <ArrowLeft />
              </Dialog.Close>
              <Search aria-hidden="true" className="m3-search__icon" />
              <input
                aria-label="Search anything"
                autoComplete="off"
                autoCorrect="off"
                className="m3-search__input"
                enterKeyHint="search"
                placeholder="Search anything"
                spellCheck={false}
                {...input}
                onChange={(event) => onValueChange(event.target.value)}
                ref={field}
                type="text"
                value={value}
              />
              {value ? (
                <IconButton
                  className="m3-search__clear"
                  label="Clear search"
                  onClick={() => {
                    onValueChange('')
                    field.current?.focus()
                  }}
                >
                  <X />
                </IconButton>
              ) : null}
            </div>
            {/* axe wants a scroll region reachable by keyboard; the options are not tab stops. */}
            <div aria-label="Results" className="m3-search__results" role="region" tabIndex={0}>
              {children}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
