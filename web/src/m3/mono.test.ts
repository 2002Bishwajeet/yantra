/**
 * Mono is for code: a command, a key, a parse error excerpt. An address, a host,
 * a hex, an id, a date, a time, an age, a count or money uses `Num`; a sentence
 * uses the body face (Y-716, Y-759). Reading the source is the only check that sees a
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
  'screens/session/GitActions.tsx',
  'screens/session/RunAsOwner.tsx',
  'screens/fleet/Github.tsx',
  'screens/repair/Repair.tsx',
  'screens/session/Session.tsx',
  'screens/fleet/Fleet.tsx',
  'screens/dashboard/Dashboard.tsx',
  'screens/settings/ConnectSheet.tsx',
  'screens/setup/Setup.tsx',
  'screens/settings/About.tsx',
  'screens/settings/RestartNow.tsx',
  'screens/settings/update.tsx',
])

const NUMBER_CALLS = /\b(ago|elapsed|money|count|uptime|tilde|day|at|on|when)\(/

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

  it('sets values, status lines and dates in the brand face', () => {
    const read = (rel: string) => readFileSync(join(src, rel), 'utf8')
    const about = read('screens/settings/About.tsx')
    for (const label of ['Target', 'Listens on']) {
      const fact = about.slice(about.indexOf(`label="${label}"`)).split('<Fact')[0]!
      expect(fact, label).not.toMatch(/<Mono\b/)
      expect(fact, label).toMatch(/<Num\b/)
    }
    expect(about.match(/label="Reached at"[^\n]*/)![0]).not.toMatch(/<Mono\b/)
    expect(read('screens/fleet/Github.tsx')).not.toMatch(/<Mono\b/)
    expect(read('screens/session/Terminal.tsx')).not.toMatch(/<Mono\b/)
    expect(read('screens/session-terminal/SessionTerminal.tsx')).not.toMatch(/<Mono\b/)
    expect(read('screens/settings/Appearance.tsx')).not.toMatch(/<Mono\b/)
  })

  it('sets a date in Num', () => {
    const devices = readFileSync(join(src, 'screens/settings/Devices.tsx'), 'utf8')
    expect(devices).toMatch(/ends <Num>\{when\(session\.ends\)\}<\/Num>/)
    expect(devices).toMatch(/enrolled <Num>\{when\(made\)\}<\/Num>/)
    expect(monoBodies('<Mono>{day(d)}</Mono>').some((b) => NUMBER_CALLS.test(b))).toBe(true)
  })

  it('catches a number in mono', () => {
    expect(monoBodies('<Mono className="x">{ago(1, 2).text}</Mono>').some((b) => NUMBER_CALLS.test(b))).toBe(true)
    expect(monoBodies('<Num>{ago(1, 2).text}</Num>')).toEqual([])
  })
})
