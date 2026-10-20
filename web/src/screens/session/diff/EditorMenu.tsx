/*
 * The menu follows T3 Code's open-in picker: one trigger, one item per editor,
 * the last one used remembered:
 * https://github.com/pingdotgg/t3code/blob/1451e7c/apps/web/src/components/chat/OpenInPicker.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useId, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/m3/button/Button'
import { Menu, MenuLinkItem, MenuPopup, MenuTrigger } from '@/m3/menu/Menu'
import { EDITORS, editorUrl, keepEditor, recallEditor, type EditorId } from './editors'

export type EditorMenuProps = {
  path: string
  machine: string
  /** Null while the thread list is read, or when it failed. */
  worktree: string | null
  line?: number
  /** Why the menu is off, for a screen reader. */
  why?: string
}

export function EditorMenu(props: EditorMenuProps) {
  const { path, machine, worktree, line, why } = props
  const whyId = useId()
  const name = `Open in editor: ${path}`
  const [last, setLast] = useState<EditorId>(recallEditor)
  const ordered = [...EDITORS].sort((a, b) => Number(b.id === last) - Number(a.id === last))
  if (worktree === null) {
    return (
      <>
        <Button
          aria-describedby={why ? whyId : undefined}
          aria-label={name}
          disabled
          icon={<ExternalLink />}
          variant="text"
        >
          Open in editor
        </Button>
        {why ? (
          <span className="m3-sr-only" id={whyId}>
            {why}
          </span>
        ) : null}
      </>
    )
  }
  return (
    <Menu>
      <MenuTrigger aria-label={name} render={<Button icon={<ExternalLink />} variant="text" />}>
        Open in editor
      </MenuTrigger>
      <MenuPopup>
        {ordered.map((editor) => (
          <MenuLinkItem
            href={editorUrl(editor.id, machine, worktree, path, editor.line ? line : undefined)}
            key={editor.id}
            onClick={() => {
              keepEditor(editor.id)
              setLast(editor.id)
            }}
          >
            {editor.label}
          </MenuLinkItem>
        ))}
      </MenuPopup>
    </Menu>
  )
}
