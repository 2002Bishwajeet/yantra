import { describe, expect, it } from 'vitest'
import type { SlashCommand } from '@/api'
import { searchCommands } from './searchCommands'

const command = (name: string, description = ''): SlashCommand => ({ name, description })
const names = (found: SlashCommand[]) => found.map((one) => one.name)

describe('searchCommands', () => {
  const commands = [
    command('compact', 'Free up context by summarizing the conversation so far'),
    command('pr-review', 'Review a pull request'),
    command('review', 'Review the current diff'),
    command('reviewer'),
    command('init', 'Initialize a new CLAUDE.md file'),
  ]

  it('ranks an exact name, then a prefix, then a word inside the name, then the description', () => {
    expect(names(searchCommands(commands, 'review'))).toEqual(['review', 'reviewer', 'pr-review'])
    expect(names(searchCommands(commands, 'summ'))).toEqual(['compact'])
  })

  it('takes letters in order as a last resort, and drops what does not match', () => {
    expect(names(searchCommands(commands, 'cpt'))).toEqual(['compact'])
    expect(searchCommands(commands, 'zzz')).toEqual([])
  })

  it('ignores case and a leading slash, and lists all in order when nothing is typed', () => {
    expect(names(searchCommands(commands, '/INIT'))).toEqual(['init'])
    expect(searchCommands(commands, '')).toEqual(commands)
  })

  it('breaks a tie by name', () => {
    expect(names(searchCommands([command('beta'), command('alpha')], 'a'))).toEqual(['alpha', 'beta'])
  })
})
