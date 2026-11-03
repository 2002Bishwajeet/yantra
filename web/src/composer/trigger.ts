/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/composer-logic.ts
 * (detectComposerTrigger, replaceTextRange):
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/composer-logic.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */

export type TriggerKind = 'path' | 'skill'

/** `@` or `$` at the start of the token that ends at the caret. */
export type Trigger = { kind: TriggerKind; query: string; start: number; end: number }

const isWhitespace = (char: string) => char === ' ' || char === '\n' || char === '\t' || char === '\r'

/** The open trigger at `caret`, or `null`. A token starts after whitespace, so the query never holds any. */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const end = Math.max(0, Math.min(text.length, caret))
  let start = end
  while (start > 0 && !isWhitespace(text[start - 1] ?? '')) start -= 1
  const token = text.slice(start, end)
  const kind = token.startsWith('@') ? 'path' : token.startsWith('$') ? 'skill' : null
  return kind ? { kind, query: token.slice(1), start, end } : null
}

/** Puts `token` and one space where the trigger was, and says where the caret goes. */
export function insertMention(text: string, range: Pick<Trigger, 'start' | 'end'>, token: string) {
  const replacement = `${token} `
  return { text: `${text.slice(0, range.start)}${replacement}${text.slice(range.end)}`, caret: range.start + replacement.length }
}
