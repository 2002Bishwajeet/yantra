import { useState, type ReactElement, type ReactNode } from 'react'
import type { ApiError } from '@/api/errors'
import { useDeleteWorkspace, useKillSession } from '@/api/mutations'
import { BottomSheet, BottomSheetClose, BottomSheetPopup, BottomSheetTrigger } from '@/m3/bottom-sheet/BottomSheet'
import { Button } from '@/m3/button/Button'
import { Dialog, DialogClose, DialogPopup, DialogTrigger } from '@/m3/dialog/Dialog'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Row, RowText } from '@/m3/row/Row'
import { Mono } from '@/m3/text/Text'
import { Tile } from '@/m3/tile/Tile'
import { useFormFactor } from '@/shell/formFactor'
import './Confirm.css'

/* Y-347 owns this file. The Dashboard, Machines, Machine and Session screens
   call the two exports; a caller passes the Fleet row it draws so the question
   repeats it word for word (BRIEF.md), and may pass its own trigger. */

type Question = {
  /** The trigger's word, and the default trigger's label. */
  label: string
  trigger?: ReactElement
  title: string
  body: ReactNode
  /** The Fleet row, repeated word for word under the question. */
  row: ReactNode
  /** Cancel, then the verb; a refusal may add a third. */
  actions: ReactNode
  error: ApiError | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** D3 §4.7: only what cannot be undone asks first. A dialog on a desktop or a
 *  tablet, a bottom sheet on a phone; the words are the boards'. */
function Confirm(props: Question) {
  const { label, trigger, title, body, row, actions, error, open, onOpenChange } = props
  const factor = useFormFactor()
  const said = error ? <ErrorSurface.Inline error={error} title={`${label} was refused`} /> : null
  const opener = trigger ?? <Button tone="error" variant="outlined" />

  if (factor === 'phone') {
    return (
      <BottomSheet onOpenChange={onOpenChange} open={open}>
        <BottomSheetTrigger render={opener}>{trigger ? undefined : label}</BottomSheetTrigger>
        <BottomSheetPopup actions={actions} className="confirm" description={body} title={title}>
          <div className="confirm__row">{row}</div>
          {said}
        </BottomSheetPopup>
      </BottomSheet>
    )
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogTrigger render={opener}>{trigger ? undefined : label}</DialogTrigger>
      <DialogPopup actions={actions} className="confirm" description={body} title={title}>
        <div className="confirm__row">{row}</div>
        {said}
      </DialogPopup>
    </Dialog>
  )
}

/** One Cancel for both containers: the close is the sheet's on a phone. */
function Cancel() {
  const factor = useFormFactor()
  const cancel = <Button variant="text" />
  return factor === 'phone' ? (
    <BottomSheetClose render={cancel}>Cancel</BottomSheetClose>
  ) : (
    <DialogClose render={cancel}>Cancel</DialogClose>
  )
}

/** The row a caller did not pass: the name and where it is. */
function Plain(props: { name: string; where: string }) {
  const { name, where } = props
  return (
    <Row>
      <Tile name={name} />
      <RowText headline={name} supporting={where} />
    </Row>
  )
}

export type KillSessionProps = {
  machine: string
  session: string
  row?: ReactNode
  /** The element that opens the question; an outlined Kill by default. */
  trigger?: ReactElement
  onDone?: () => void
}

/** `DELETE /api/machines/{machine}/sessions/{session}`. `killed: false` is a
 *  session already gone, which is the state asked for (I-30), so it closes
 *  the same way. */
export function KillSession(props: KillSessionProps) {
  const { machine, session, row, trigger, onDone } = props
  const [open, setOpen] = useState(false)
  const factor = useFormFactor()
  const kill = useKillSession()
  const confirm = () =>
    kill.mutate(
      { machine, session },
      {
        onSuccess: () => {
          setOpen(false)
          onDone?.()
        },
      },
    )

  return (
    <Confirm
      actions={
        <>
          <Cancel />
          <Button disabled={kill.isPending} onClick={confirm} tone="error">
            {kill.isPending ? 'killing…' : 'Kill'}
          </Button>
        </>
      }
      body={
        factor === 'phone'
          ? `The tmux session on ${machine} and every process in it end now. The agent gets no chance to finish its turn.`
          : `The tmux session on ${machine} and every process in it end now, and the agent gets no chance to finish its turn.`
      }
      error={kill.error}
      label="Kill"
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) kill.reset()
      }}
      open={open}
      row={row ?? <Plain name={session} where={machine} />}
      title={`Kill ${session}?`}
      trigger={trigger}
    />
  )
}

export type DeleteWorkspaceProps = {
  name: string
  row?: ReactNode
  /** Skip the daemon's refusal to strand a live session from the first ask. */
  force?: boolean
  trigger?: ReactElement
  onDone?: () => void
}

/** `DELETE /api/workspaces/{name}`. The daemon answers 409 for a workspace
 *  whose session is live, and the question then offers *Delete anyway*, which
 *  sends `?force=true` — a person meant it, twice. */
export function DeleteWorkspace(props: DeleteWorkspaceProps) {
  const { name, row, force, trigger, onDone } = props
  const [open, setOpen] = useState(false)
  const remove = useDeleteWorkspace()
  const confirm = (forced: boolean) =>
    remove.mutate(
      { name, force: forced },
      {
        onSuccess: () => {
          setOpen(false)
          onDone?.()
        },
      },
    )
  const live = remove.error?.status === 409

  return (
    <Confirm
      actions={
        <>
          <Cancel />
          {live ? (
            <Button disabled={remove.isPending} onClick={() => confirm(true)} tone="error">
              {remove.isPending ? 'deleting…' : 'Delete anyway'}
            </Button>
          ) : (
            <Button disabled={remove.isPending} onClick={() => confirm(force ?? false)} tone="error">
              {remove.isPending ? 'deleting…' : 'Delete'}
            </Button>
          )}
        </>
      }
      body={
        <>
          This removes the workspace file from <Mono>~/.config/yantra/workspaces</Mono> on this machine; the
          repository and the tmux session stay.
        </>
      }
      error={remove.error}
      label="Delete"
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) remove.reset()
      }}
      open={open}
      row={row ?? <Plain name={name} where="~/.config/yantra/workspaces" />}
      title={`Delete ${name}?`}
      trigger={trigger}
    />
  )
}
