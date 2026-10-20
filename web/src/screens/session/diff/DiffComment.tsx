/*
 * The comment box follows T3 Code's diff comment annotation: a textarea under
 * the selected lines, Escape to cancel, ⌘/Ctrl+Enter to add:
 * https://github.com/pingdotgg/t3code/blob/1451e7c/apps/web/src/components/diffs/DiffCommentAnnotation.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useId, useState } from 'react'
import { Button } from '@/m3/button/Button'
import { isSubmit } from './comment'

export type DiffCommentProps = {
  /** "src/new.rs L3-L4": what the comment is on, said to a screen reader. */
  label: string
  onCancel: () => void
  onSubmit: (text: string) => void
}

/** Takes focus when it opens. The caller returns focus when it closes. */
export function DiffComment(props: DiffCommentProps) {
  const { label, onCancel, onSubmit } = props
  const [text, setText] = useState('')
  const hint = useId()
  const empty = text.trim() === ''
  return (
    <form
      className="diff-comment"
      onPointerDown={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault()
        if (!empty) onSubmit(text)
      }}
    >
      <textarea
        aria-describedby={hint}
        aria-label={`Comment on ${label}`}
        autoFocus
        className="diff-comment__text"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          } else if (isSubmit(event)) {
            event.preventDefault()
            if (!empty) onSubmit(text)
          }
        }}
        placeholder="Add a comment…"
        rows={3}
        value={text}
      />
      <div className="diff-comment__foot">
        <span className="diff-comment__hint" id={hint}>
          ⌘/Ctrl+Enter adds it to your message. Nothing is sent.
        </span>
        <Button onClick={onCancel} type="button" variant="text">
          Cancel
        </Button>
        <Button disabled={empty} type="submit">
          Add to message
        </Button>
      </div>
    </form>
  )
}
