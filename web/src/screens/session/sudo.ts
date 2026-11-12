import type { Harness } from '@/api/thread'
import type { Tool } from './timeline'

export type Sudo = { command: string; refused: boolean }

const SUDO = /^sudo(\s|$)/
// Controls, format characters (bidi overrides, zero-width) and line or
// paragraph separators: each can make the shown text differ from the typed text.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const EACH_UNSAFE = new RegExp(`(${UNSAFE.source})`, 'u')
const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }

function escapeOf(hidden: string): string {
  const code = hidden.codePointAt(0)!
  const hex = code.toString(16)
  return NAMED[hidden] ?? (code < 0x100 ? `\\x${hex.padStart(2, '0')}` : `\\u{${hex}}`)
}

/** A refused command in parts, with each unsafe character as an escape a
 *  person can read. No part holds an unsafe character. */
export function spelled(command: string): { text: string; escape: boolean }[] {
  // A split on one capture group puts the captures at the odd places.
  return command
    .split(EACH_UNSAFE)
    .map((text, at) => (at % 2 === 1 ? { text: escapeOf(text), escape: true } : { text, escape: false }))
    .filter((part) => part.text !== '')
}

/** ADR-0046 3.4: a command with an unsafe character is shown but never typed. */
export const typable = (command: string): Sudo => ({ command, refused: UNSAFE.test(command) })

/** What the page says beside a refused command. */
export const NOT_TYPED = 'This command holds a control character, so Yantra will not type it. Copy it by hand.'

/** ADR-0046 3.2: only a Claude command that starts with `sudo` is offered. */
export function sudoCommand(tool: Tool, harness: Harness | null): Sudo | null {
  if (harness !== 'claude' || tool.itemType !== 'command_execution') return null
  const command = tool.title?.trim() ?? ''
  return SUDO.test(command) ? typable(command) : null
}
