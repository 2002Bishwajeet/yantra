/*
 * The editor choice follows T3 Code's open-in picker: a menu of editors, and the
 * last one picked is remembered:
 * https://github.com/pingdotgg/t3code/blob/1451e7c/apps/web/src/components/chat/OpenInPicker.logic.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
export type EditorId = 'vscode' | 'cursor' | 'zed'

/** `line` is true where the scheme takes `:line`. Zed's ssh scheme does not
 *  (zed.dev/docs/remote-development, read 2026-10-20). */
export const EDITORS: readonly { id: EditorId; label: string; line: boolean }[] = [
  { id: 'vscode', label: 'VS Code', line: true },
  { id: 'cursor', label: 'Cursor', line: true },
  { id: 'zed', label: 'Zed', line: false },
]

const encode = (path: string) =>
  path
    .split('/')
    .filter((segment) => segment !== '')
    .map(encodeURIComponent)
    .join('/')

/** A machine name is an ssh destination (ADR-0009), so the editor connects to
 *  it as `ssh <machine>` does. Each path segment is percent-encoded. */
export function editorUrl(editor: EditorId, machine: string, worktree: string, path: string, line?: number): string {
  const where = `/${encode(`${worktree}/${path}`)}`
  const host = encodeURIComponent(machine)
  switch (editor) {
    case 'vscode':
    case 'cursor':
      return `${editor === 'vscode' ? 'vscode' : 'cursor'}://vscode-remote/ssh-remote+${host}${where}${line ? `:${line}` : ''}`
    case 'zed':
      return `zed://ssh/${host}${where}`
  }
}

const KEY = 'yantra.editor'
const IDS: ReadonlySet<string> = new Set(EDITORS.map((one) => one.id))

/** The editor last used, or VS Code. Storage can be blocked or empty. */
export function recallEditor(): EditorId {
  try {
    const kept = localStorage.getItem(KEY)
    if (kept !== null && IDS.has(kept)) return kept as EditorId
  } catch {
    // A blocked store is no preference.
  }
  return 'vscode'
}

export function keepEditor(editor: EditorId): void {
  try {
    localStorage.setItem(KEY, editor)
  } catch {
    // The choice then lasts until the page closes.
  }
}
