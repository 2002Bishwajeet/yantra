/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/ComposerCommandMenu.tsx:
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/ComposerCommandMenu.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useLayoutEffect, useRef } from 'react'
import type { ApiError } from '@/api/errors'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import type { TriggerKind } from './trigger'
import './MentionMenu.css'

/** `hint` is a slash command's argument: a pick of a command with none sends it at once. */
export type MentionItem = { id: string; label: string; description: string; badge?: string; hint?: string }

export type MentionMenuProps = {
  id: string
  kind: TriggerKind
  loading: boolean
  error: ApiError | null
  items: readonly MentionItem[]
  /** What an empty list says in place of the kind's own words. */
  empty?: string
  active: number
  onHover: (index: number) => void
  onPick: (item: MentionItem) => void
  onRetry: () => void
}

const LABEL: Record<TriggerKind, string> = { path: 'Files', skill: 'Skills', command: 'Commands' }
const LOADING: Record<TriggerKind, string> = {
  path: 'Searching workspace files…',
  skill: 'Searching skills…',
  command: 'Loading commands…',
}
const EMPTY: Record<TriggerKind, string> = {
  path: 'No matching files.',
  skill: 'No matching skills.',
  command: 'No matching commands.',
}

/** The `id` the textarea names in `aria-activedescendant`. */
export const optionId = (menu: string, index: number) => `${menu}-${index}`

/** The suggestions above the composer. Focus stays in the field, which drives the list as a combobox. */
export function MentionMenu(props: MentionMenuProps) {
  const { id, kind, loading, error, items, empty, active, onHover, onPick, onRetry } = props
  const list = useRef<HTMLUListElement>(null)

  useLayoutEffect(() => {
    list.current?.querySelector(`[id="${optionId(id, active)}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [id, active])

  if (error) {
    return (
      <div className="mention-menu">
        <ErrorSurface.Inline error={error} reset={onRetry} title={`${LABEL[kind]} could not be read`} />
      </div>
    )
  }
  return (
    <div className="mention-menu">
      {items.length > 0 ? (
        <ul aria-label={LABEL[kind]} className="mention-menu__list" id={id} ref={list} role="listbox">
          {items.map((item, index) => (
            <li
              aria-selected={index === active}
              className="mention-menu__option"
              id={optionId(id, index)}
              key={item.id}
              onClick={() => onPick(item)}
              // The field keeps focus, so the caret and the trigger stay where they were.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (index !== active) onHover(index)
              }}
              role="option"
            >
              <span className="mention-menu__label m3-clip">{item.label}</span>
              <span className="mention-menu__description m3-clip">{item.description}</span>
              {item.hint ? <span className="mention-menu__hint m3-clip">{item.hint}</span> : null}
              {item.badge ? <span className="mention-menu__badge">{item.badge}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mention-menu__empty" id={id} role="status">
          {loading ? LOADING[kind] : (empty ?? EMPTY[kind])}
        </p>
      )}
    </div>
  )
}
