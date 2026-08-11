import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog'

/** The question `Confirm` asks, in its own module because it is the only thing
 *  on `/` that pulls Base UI's dialog in — and nothing on the page has asked one
 *  yet on the first paint. That is also why there is no `DialogTrigger` here:
 *  the trigger stays eager, the way `Overflow.tsx` leaves its own behind. */
export function ConfirmPopup({
  title,
  body,
  confirm,
  open,
  onOpenChange,
  onConfirm,
}: {
  title: string
  body: string
  confirm: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
            variant="destructive"
          >
            {confirm}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
