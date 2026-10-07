import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const web = resolve(__dirname, '..')
const read = (p: string) => readFileSync(resolve(web, p), 'utf8')

describe('Y-441 budget figures', () => {
  it('the script prints headroom for both totals and writes no limit in a message', () => {
    const src = read('scripts/budget.mjs')
    expect(src).toContain('headroomLine(FIRST_LOAD_CEILING, firstLoad)')
    expect(src).toContain('headroomLine(FONTS_CEILING, fontBytes)')
    const code = src.split('\n').filter((l) => !l.startsWith('//')).join('\n')
    expect(code).not.toMatch(/(200|80) KiB/)
  })

  it('the README section "What it weighs" quotes no dated byte figure', () => {
    const readme = read('README.md')
    const section = readme.split('## What it weighs')[1].split(/\n## /)[0]
    expect(section).not.toMatch(/As of 20\d\d-/)
    expect(section).not.toMatch(/148\.7|78\.5/)
    expect(section).toContain('npm run budget')
  })

  it('D3 9.1 says its byte counts are dated and points to npm run budget', () => {
    const d3 = read('../docs/design/03-dashboard-surface.md')
    expect(d3).toContain('2026-10-07, Y-441')
    expect(d3).toContain('`npm run budget`')
  })

  it('the Y-325 row quotes no byte figure', () => {
    const row = read('../tracker.md').split('\n').find((line) => line.startsWith('| Y-325 |')) ?? ''
    expect(row).toContain('npm run budget')
    expect(row).not.toMatch(/\d[\d,.]* ?(B|KiB)\b/)
  })
})
