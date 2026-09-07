import type { ReactNode } from 'react'
import { BottomSheet, BottomSheetPopup } from '@/m3/bottom-sheet/BottomSheet'
import { Dialog, DialogPopup } from '@/m3/dialog/Dialog'
import { useFormFactor } from '@/shell/formFactor'

export type SheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  actions?: ReactNode
  children?: ReactNode
}

/** The edit sheet a row opens: a dialog on a desktop and a tablet, a bottom
 *  sheet on a phone (BRIEF.md, form factors). The one place a secret or a
 *  long value is drawn. */
export function Sheet(props: SheetProps) {
  const { open, onOpenChange, title, description, actions, children } = props
  const factor = useFormFactor()
  if (factor === 'phone') {
    return (
      <BottomSheet open={open} onOpenChange={onOpenChange}>
        <BottomSheetPopup actions={actions} description={description} title={title}>
          {children}
        </BottomSheetPopup>
      </BottomSheet>
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup actions={actions} description={description} title={title}>
        {children}
      </DialogPopup>
    </Dialog>
  )
}
