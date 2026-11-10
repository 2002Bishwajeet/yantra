import { useFormFactor } from './formFactor'
import { BottomSheet, BottomSheetPopup } from '@/m3/bottom-sheet/BottomSheet'
import { Dialog, DialogClose, DialogPopup } from '@/m3/dialog/Dialog'
import { Button } from '@/m3/button/Button'
import { Kbd } from '@/m3/kbd/Kbd'
import { KEYS, SHELL_KEYS } from '@/screens/session/keys'
import './Palette.css'

const ROWS = [...SHELL_KEYS, ...KEYS.map((one) => ({ label: one.label, display: one.display }))]

function Rows() {
  return (
    <dl className="keyhelp">
      {ROWS.map((row) => (
        <div className="keyhelp__row" key={row.label}>
          <dt>{row.label}</dt>
          <dd>
            <Kbd>{row.display}</Kbd>
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Every chord in one place. A phone gets a bottom sheet; nothing in it waits on a hover. */
export function KeyboardHelp(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { open, onOpenChange } = props
  const close = <DialogClose render={<Button variant="text" />}>Close</DialogClose>
  if (useFormFactor() === 'phone') {
    return (
      <BottomSheet onOpenChange={onOpenChange} open={open}>
        <BottomSheetPopup title="Keyboard shortcuts">
          <Rows />
        </BottomSheetPopup>
      </BottomSheet>
    )
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup actions={close} title="Keyboard shortcuts">
        <Rows />
      </DialogPopup>
    </Dialog>
  )
}
