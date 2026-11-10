/*
 * The diff chord is T3 Code's own default (mod+d, diff.toggle):
 * https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/keybindings.ts
 * T3 binds no key to commit, push or a PR, so those chords are Yantra's.
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */

export type LoopId = 'issue' | 'diff' | 'commit' | 'push' | 'pr' | 'merge'

type Key = { id: LoopId; label: string; code: string; alt: boolean; display: string }

const MAC = navigator.userAgent.includes('Mac')

// Chrome keeps Ctrl+Shift+I, C and J, so only the diff chord goes without Alt. `code`, not `key`,
// because Option+C types "ç" on a Mac. On a Mac the Alt chords use Control, not Command: ⌘⌥I, C and J
// open DevTools and ⌘⌥M minimises every window, while ⌃⌥ letters belong to no browser.
const chord = (id: LoopId, label: string, letter: string, alt: boolean): Key => ({
  id,
  label,
  code: `Key${letter}`,
  alt,
  display: MAC ? `${alt ? '⌃⌥' : '⌘'}${letter}` : `Ctrl ${alt ? 'Alt ' : ''}${letter}`,
})

export const KEYS: readonly Key[] = [
  chord('issue', 'Start from issue', 'I', true),
  chord('diff', 'Diff', 'D', false),
  chord('commit', 'Commit', 'C', true),
  chord('push', 'Push', 'P', true),
  chord('pr', 'Open PR', 'R', true),
  chord('merge', 'Merge', 'M', true),
]

export const keyOf = (id: LoopId): Key => KEYS.find((one) => one.id === id)!

/** The other two chords of the shell, for the `?` sheet. ⌘K itself is bound in Palette.tsx. */
export const SHELL_KEYS = [
  { label: 'Search', display: MAC ? '⌘K' : 'Ctrl K' },
  { label: 'Keyboard shortcuts', display: '?' },
] as const

/** The terminal pane takes every key it is given, and `.xterm` is its own mark. */
const inTerminal = (at: Element | null) => at?.closest('.xterm') != null

const inField = (at: Element | null) =>
  at instanceof HTMLElement && (at.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(at.tagName))

/** Every chord has a modifier, so a text field does not stop one; the terminal does. */
export function matchChord(event: KeyboardEvent, mac = MAC): LoopId | null {
  if (event.shiftKey) return null
  const modified = mac && event.altKey ? event.ctrlKey && !event.metaKey : event.metaKey || event.ctrlKey
  if (!modified) return null
  if (inTerminal(document.activeElement)) return null
  return KEYS.find((one) => one.code === event.code && one.alt === event.altKey)?.id ?? null
}

/** `?` is a typed character, so it waits for focus to be on neither a field nor the terminal. */
export function matchHelp(event: KeyboardEvent): boolean {
  if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return false
  return !inTerminal(document.activeElement) && !inField(document.activeElement)
}
