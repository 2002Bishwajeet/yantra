/**
 * Mono is for code: a command, a key, a path-as-code, a fingerprint, a hex, an
 * address, a host. A time, an age, a count, money or a path in prose uses `Num`
 * or the body face (Y-716). Reading the source is the only check that sees a
 * file jsdom never renders.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = resolve(process.cwd(), 'src')

const ALLOWED = new Set([
  'm3/text/Text.tsx',
  'm3/copyable/Copyable.tsx',
  'm3/kbd/Kbd.tsx',
  'screens/session/markdown/CodeBlock.tsx',
  'screens/session/WorkLog.tsx',
  'screens/session/Turns.tsx',
  'screens/session/Terminal.tsx',
  'screens/fleet/Github.tsx',
  'screens/machine/SudoSheet.tsx',
  'screens/repair/Repair.tsx',
  'screens/session/Session.tsx',
  'screens/fleet/Fleet.tsx',
  'screens/dashboard/Dashboard.tsx',
  'screens/settings/ConnectSheet.tsx',
  'screens/session-terminal/SessionTerminal.tsx',
  'screens/setup/Setup.tsx',
  'screens/settings/About.tsx',
  'screens/settings/Appearance.tsx',
  'screens/settings/RestartNow.tsx',
  'screens/settings/update.tsx',
])

const NUMBER_CALLS = /\b(ago|elapsed|money|count|uptime|tilde)\(/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : []
  })
}

/** Each `<Mono ...>...</Mono>` body, so a call inside one is found. */
export function monoBodies(text: string): string[] {
  return [...text.matchAll(/<Mono\b[^>]*>([\s\S]*?)<\/Mono>/g)].map((one) => one[1]!)
}

describe('mono is for code', () => {
  const files = sources(src).map((path) => ({ rel: relative(src, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }))

  it('appears only in the files that show code', () => {
    const stray = files.filter((one) => !ALLOWED.has(one.rel) && /<Mono\b|m3-mono/.test(one.text)).map((one) => one.rel)
    expect(stray).toEqual([])
  })

  it('never sets a time, an age, a count, money or a path', () => {
    const wrong = files
      .filter((one) => one.rel.startsWith('screens/') || one.rel.startsWith('shell/'))
      .filter((one) => monoBodies(one.text).some((body) => NUMBER_CALLS.test(body)))
      .map((one) => one.rel)
    expect(wrong).toEqual([])
  })

  it('keeps a parse error excerpt and a scope token in mono', () => {
    const read = (rel: string) => readFileSync(join(src, rel), 'utf8')
    const mono = (rel: string) => monoBodies(read(rel)).join('\n')
    expect(read('screens/repair/Repair.tsx')).toMatch(/<Mono className="repair__error"/)
    expect(read('screens/session/Session.tsx')).toMatch(/<Mono className="session__error/)
    expect(read('screens/fleet/Fleet.tsx')).toMatch(/<Mono className="fleet__detail m3-wrap">\{row\.error\}/)
    expect(mono('screens/dashboard/Dashboard.tsx')).toContain('row.error')
    expect(mono('screens/settings/ConnectSheet.tsx')).toContain('{scope}')
  })

  it('catches a number in mono', () => {
    expect(monoBodies('<Mono className="x">{ago(1, 2).text}</Mono>').some((b) => NUMBER_CALLS.test(b))).toBe(true)
    expect(monoBodies('<Num>{ago(1, 2).text}</Num>')).toEqual([])
  })
})
