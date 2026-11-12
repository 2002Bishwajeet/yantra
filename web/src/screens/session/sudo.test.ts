import { describe, expect, it } from 'vitest'
import type { Harness } from '@/api/thread'
import { spelled, sudoCommand } from './sudo'
import type { Tool } from './timeline'

const tool = (title: string | null, itemType: Tool['itemType'] = 'command_execution'): Tool => ({
  kind: 'tool',
  id: 't',
  turn: 1,
  itemType,
  status: 'completed',
  title,
  output: null,
})

const offer = (title: string | null, harness: Harness | null = 'claude') => sudoCommand(tool(title), harness)

describe('sudoCommand', () => {
  it('offers a sudo command, trimmed', () => {
    expect(offer('  sudo systemctl restart sshd \n')).toEqual({
      command: 'sudo systemctl restart sshd',
      refused: false,
    })
    expect(offer('sudo')).toEqual({ command: 'sudo', refused: false })
  })

  it('does not offer what only looks like sudo', () => {
    expect(offer('sudoers --check')).toBeNull()
    expect(offer('cd /etc && sudo rm x')).toBeNull()
    expect(offer('ls')).toBeNull()
    expect(offer(null)).toBeNull()
  })

  it('offers only a Claude command item', () => {
    expect(offer('sudo ls', 'codex')).toBeNull()
    expect(offer('sudo ls', null)).toBeNull()
    expect(sudoCommand(tool('sudo ls', 'file_change'), 'claude')).toBeNull()
  })

  it.each([
    ['a newline', 'sudo ls\nrm -rf /'],
    ['a carriage return', 'sudo ls\rrm x'],
    ['a tab', 'sudo\tls'],
    ['ESC', 'sudo ls \u001b[2J'],
    ['DEL', 'sudo ls\u007f'],
    ['a C1 control', 'sudo ls\u009b'],
    ['a bidi override', 'sudo ls ‮txt.sh'],
    ['a zero-width space', 'sudo ls​x'],
    ['a line separator', 'sudo ls x'],
  ])('refuses %s', (_, command) => {
    expect(offer(command)).toEqual({ command, refused: true })
  })
})

describe('spelled', () => {
  it('leaves a command with no unsafe character in one part', () => {
    expect(spelled('sudo ls -la')).toEqual([{ text: 'sudo ls -la', escape: false }])
  })

  it.each([
    ['a newline', '\n', '\\n'],
    ['a carriage return', '\r', '\\r'],
    ['a tab', '\t', '\\t'],
    ['ESC', '\u001b', '\\x1b'],
    ['NUL', '\u0000', '\\x00'],
    ['DEL', '\u007f', '\\x7f'],
    ['a C1 control', '\u009b', '\\x9b'],
    ['a soft hyphen', '\u00ad', '\\xad'],
    ['a bidi override', '\u202e', '\\u{202e}'],
    ['a zero-width space', '\u200b', '\\u{200b}'],
    ['a line separator', '\u2028', '\\u{2028}'],
    ['a tag character above the BMP', '\u{e0041}', '\\u{e0041}'],
  ])('spells %s as an escape', (_, hidden, escape) => {
    expect(spelled(`sudo ls${hidden}x`)).toEqual([
      { text: 'sudo ls', escape: false },
      { text: escape, escape: true },
      { text: 'x', escape: false },
    ])
  })

  it('spells each hidden character of a paste break, and no part holds one', () => {
    const parts = spelled("sudo apt update\u001b[201~\rsudo sh -c 'x'")
    expect(parts.map((part) => part.text).join('')).toBe("sudo apt update\\x1b[201~\\rsudo sh -c 'x'")
    expect(parts.filter((part) => part.escape).map((part) => part.text)).toEqual(['\\x1b', '\\r'])
  })
})
