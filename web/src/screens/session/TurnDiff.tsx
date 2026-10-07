import { useId, useState } from 'react'
import { Undo2 } from 'lucide-react'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Dialog, DialogClose, DialogPopup, DialogTrigger } from '@/m3/dialog/Dialog'
import { Disclosure } from '@/m3/disclosure/Disclosure'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import type { TurnDiff as Diff } from './timeline'

type Tone = 'meta' | 'hunk' | 'add' | 'del' | 'same'
type Line = { text: string; tone: Tone }

/** The paths a unified diff names, and each line with what it is. A file's
 *  header runs from `diff --git` to its first hunk, so a removed line that
 *  starts `---` is still a removal. */
function read(unified: string): { files: string[]; lines: Line[] } {
  const files: string[] = []
  const lines: Line[] = []
  let header = false
  for (const text of unified.split('\n')) {
    if (text.startsWith('diff --git ')) {
      header = true
      files.push(/ b\/(.+)$/.exec(text)?.[1] ?? text.slice('diff --git '.length))
    } else if (text.startsWith('@@')) {
      header = false
    }
    const tone: Tone = header
      ? 'meta'
      : text.startsWith('@@')
        ? 'hunk'
        : text.startsWith('+')
          ? 'add'
          : text.startsWith('-')
            ? 'del'
            : 'same'
    lines.push({ text, tone })
  }
  if (lines.at(-1)?.text === '') lines.pop()
  return { files, lines }
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
export function TurnDiff(props: { diff: Diff; disabled: boolean; onRevert: (turn: number) => boolean }) {
  const { diff, disabled, onRevert } = props
  const { files, lines } = read(diff.unified)
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
        <pre className="chat__diff-text">
          <code>
            {lines.map((line, at) => (
              // Each line is a block, so an empty one still takes its height.
              <span data-tone={line.tone} key={at}>
                {line.text || ' '}
              </span>
            ))}
          </code>
        </pre>
      </Disclosure>
      {diff.reverted ? null : <Revert disabled={disabled} onRevert={onRevert} turn={diff.turn} />}
    </Card>
  )
}
