import { describe, expect, it } from 'vitest'
import type { Harness } from '@/api/thread'
import { sudoCommand } from './sudo'
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
