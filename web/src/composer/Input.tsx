/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/ChatComposer.tsx (the prompt field):
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/ChatComposer.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import type { KeyboardEvent, Ref } from 'react'
import TextareaAutosize, { type TextareaAutosizeProps } from 'react-textarea-autosize'
import { submissionIntentForKey } from './keys'

export type InputProps = Omit<TextareaAutosizeProps, 'ref'> & {
  ref?: Ref<HTMLTextAreaElement>
  /** Whether a bare Enter sends; a code fence or a list still asks for Mod+Enter. */
  enterSends: boolean
  onSend: () => void
}

/** An auto-growing field that stops at 40vh and then scrolls. */
export function Input(props: InputProps) {
  const { enterSends, onSend, onKeyDown, value, ...rest } = props
  const keydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    const { key, shiftKey, altKey, metaKey, ctrlKey, repeat, keyCode } = event
    const pressed = { key, shiftKey, altKey, metaKey, ctrlKey, repeat, keyCode, isComposing: event.nativeEvent.isComposing }
    if (submissionIntentForKey({ event: pressed, enterSends, prompt: String(value ?? '') }) === 'send') {
      event.preventDefault()
      onSend()
    }
  }
  return (
    <TextareaAutosize
      autoComplete="off"
      className="composer__input"
      minRows={1}
      onKeyDown={keydown}
      value={value}
      {...rest}
    />
  )
}
