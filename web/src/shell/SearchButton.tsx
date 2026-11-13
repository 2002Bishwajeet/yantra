import { Search } from 'lucide-react'
import { IconButton } from '@/m3/icon-button/IconButton'
import { openPalette } from './loopCommands'
import { warmPalette } from './Palette'

/** The phone and the tablet have no pill and no keyboard; this opens the one Palette the shell mounts. */
export function SearchButton() {
  return (
    <IconButton
      aria-haspopup="dialog"
      label="Search"
      onClick={(event) => {
        // Safari does not focus a button on tap; the palette hands the focus back to the active element.
        event.currentTarget.focus()
        openPalette('')
      }}
      onFocus={warmPalette}
      onPointerEnter={warmPalette}
      variant="tonal"
    >
      <Search />
    </IconButton>
  )
}
