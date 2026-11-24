/**
 * Y-763: copy that named the plumbing. Reading the sources is the only check
 * that sees every string at once, including those on screens a test never opens.
 * It cannot read a line that code puts together: `test/capitals.ts` reads those as each test draws them.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = resolve(process.cwd(), 'src')

const FILES = [
  'screens/machine/Readiness.tsx',
  'screens/setup/Setup.tsx',
  'screens/settings/Agents.tsx',
  'screens/settings/Notifications.tsx',
  'screens/settings/PushSetup.tsx',
  'screens/settings/Appearance.tsx',
  'screens/settings/categories.tsx',
  'screens/settings/Providers.tsx',
  'screens/settings/About.tsx',
  'screens/machines/Unclaimed.tsx',
  'screens/dashboard/Dashboard.tsx',
  'screens/machine/Sessions.tsx',
  'screens/session-terminal/SessionTerminal.tsx',
  'screens/usage/Usage.tsx',
  'screens/repair/Repair.tsx',
  'screens/setup/steps.ts',
  'api/client.ts',
  'lib/github.ts',
  'lib/platform.ts',
  'lib/checks.ts',
]

const PHRASES = [
  'ssh round trip',
  'beat has arrived',
  'holds no switch',
  'Push relay',
  'no workspace claims',
  'no fleet total',
  '44px',
  'The look failed',
  'nothing to repair',
  'No separate login',
]

const read = (file: string) => readFileSync(resolve(src, file), 'utf8')

describe('the copy that named the plumbing', () => {
  it.each(FILES)('%s keeps none of the old phrases', (file) => {
    const text = read(file)
    for (const phrase of PHRASES) expect(text, phrase).not.toContain(phrase)
  })

  it.each(FILES)('%s starts each written supporting line, blurb, reason and note with a capital', (file) => {
    const lower = /(?:supporting=(?:["']|\{`)|blurb: ['"`]|why=["']|<Note>)[a-z]+[ ·]/g
    expect(read(file).match(lower) ?? []).toEqual([])
  })
})
