import { useId, useState } from 'react'
import { Undo2 } from 'lucide-react'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Dialog, DialogClose, DialogPopup, DialogTrigger } from '@/m3/dialog/Dialog'
import { Disclosure } from '@/m3/disclosure/Disclosure'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import type { Workspace } from '@/api'
import { DiffSheet } from './diff/DiffSheet'
import type { TurnDiff as Diff } from './timeline'

/** The paths a unified diff names. */
function filesOf(unified: string): string[] {
  const files: string[] = []
  for (const text of unified.split('\n')) {
    if (text.startsWith('diff --git ')) {
      files.push(/ b\/(.+)$/.exec(text)?.[1] ?? text.slice('diff --git '.length))
    }
  }
  return files
}

/** Asks before the files go back. The conversation is not rewound. */
function Revert(props: { turn: number; disabled: boolean; onRevert: (turn: number) => boolean }) {
  const { turn, disabled, onRevert } = props
  const [open, setOpen] = useState(false)
  const why = useId()
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        aria-describedby={disabled ? why : undefined}
        disabled={disabled}
        render={<Button icon={<Undo2 />} variant="text" />}
      >
        Revert to before this turn
      </DialogTrigger>
      {disabled ? (
        <span className="m3-sr-only" id={why}>
          A revert waits until no turn runs and the chat is connected.
        </span>
      ) : null}
      <DialogPopup
        actions={
          <>
            <DialogClose render={<Button variant="text" />}>Cancel</DialogClose>
            <Button
              onClick={() => {
                if (onRevert(turn - 1)) setOpen(false)
              }}
            >
              Revert
            </Button>
          </>
        }
        description="The files in this chat’s worktree go back to how they were before this turn, and every later turn’s changes go with them. The conversation stays as it is."
        title={`Revert to before turn ${turn}?`}
      />
    </Dialog>
  )
}

/** What one turn changed (Y-448): the files, the unified diff on request,
 *  and a revert to the tree before it. A diff with no files draws nothing. */
export function TurnDiff(props: {
  diff: Diff
  disabled: boolean
  onRevert: (turn: number) => boolean
  workspace: Workspace
  thread: string | null
  onComment: (block: string) => void
}) {
  const { diff, disabled, onRevert, workspace, thread, onComment } = props
  const files = filesOf(diff.unified)
  if (files.length === 0) return null
  return (
    <Card
      className="chat__diff"
      data-reverted={diff.reverted ? '' : undefined}
      render={<article aria-label={`What turn ${diff.turn} changed`} />}
      surface="low"
    >
      <Disclosure
        action="Diff"
        summary={
          <span className="chat__diff-summary">
            {/* The spaces keep the words apart in the trigger's name. */}
            <Eyebrow>Changed files</Eyebrow> <Mono>{files.length}</Mono>{' '}
            {diff.reverted ? <span className="chat__diff-reverted">Reverted</span> : null}
          </span>
        }
      >
        <ul aria-label="Changed files" className="chat__diff-files">
          {files.map((file) => (
            <li key={file}>
              <Mono>{file}</Mono>
            </li>
          ))}
        </ul>
        {diff.truncated ? (
          <Text render={<p />} scale="body-small" tone="variant">
            Cut at 256 KiB
          </Text>
        ) : null}
        {/* The note above is this turn's cut, so the viewer is told nothing was. */}
        <DiffSheet
          onComment={onComment}
          state={{ state: 'ready', data: { unified: diff.unified, truncated: false, filesTruncated: false } }}
          thread={thread}
          workspace={workspace}
        />
      </Disclosure>
      {diff.reverted ? null : <Revert disabled={disabled} onRevert={onRevert} turn={diff.turn} />}
    </Card>
  )
}
