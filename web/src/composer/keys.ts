/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/composer-logic.ts
 * (composerRequiresModifier, composerSubmissionIntentForKey):
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/composer-logic.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */

const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\S/

/** Enter must not send while the words are code or a list: it is a new line there. */
export function composerRequiresModifier(enterSends: boolean, prompt: string): boolean {
  if (!enterSends) return true
  const lines = prompt.split('\n')
  const fences = lines.filter((line) => line.trimStart().startsWith('```')).length
  return fences % 2 === 1 || LIST_LINE.test(lines[lines.length - 1] ?? '')
}

export type KeyLike = {
  key: string
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
}

/** `'send'` when this key press sends the prompt, and `null` when the field keeps it. */
export function submissionIntentForKey(input: {
  event: KeyLike
  enterSends: boolean
  prompt: string
}): 'send' | null {
  const { event } = input
  // 229 is the key code a browser gives a press that an input method consumes.
  if (event.isComposing || event.keyCode === 229 || event.repeat) return null
  if (event.key !== 'Enter' || event.shiftKey || event.altKey) return null
  const modified = event.metaKey || event.ctrlKey
  return composerRequiresModifier(input.enterSends, input.prompt) && !modified ? null : 'send'
}
