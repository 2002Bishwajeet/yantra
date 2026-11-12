import type { Harness } from '@/api/thread'
import type { Tool } from './timeline'

export type Sudo = { command: string; refused: boolean }

const SUDO = /^sudo(\s|$)/
// Controls, format characters (bidi overrides, zero-width) and line or
// paragraph separators: each can make the shown text differ from the typed text.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/** ADR-0046 3.2: only a Claude command that starts with `sudo` is offered, and
 *  one with an unsafe character is shown but never typed. */
export function sudoCommand(tool: Tool, harness: Harness | null): Sudo | null {
  if (harness !== 'claude' || tool.itemType !== 'command_execution') return null
  const command = tool.title?.trim() ?? ''
  if (!SUDO.test(command)) return null
  return { command, refused: UNSAFE.test(command) }
}
