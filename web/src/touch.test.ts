/**
 * Y-671 (research note 25 F2): every `:hover` rule sits inside a
 * `(hover: hover)` media query, or a tap leaves the hover state stuck on a
 * phone. This reads every stylesheet as text, because jsdom applies none.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = resolve(process.cwd(), 'src')

function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return stylesheets(path)
    return path.endsWith('.css') ? [path] : []
  })
}

/** Selectors that hold `:hover` outside a `(hover: hover)` block. */
function ungatedHovers(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const found: string[] = []
  const gates: boolean[] = []
  let prelude = ''
  for (const ch of text) {
    if (ch === '{') {
      const head = prelude.trim()
      const gated = gates.some(Boolean)
      if (head.startsWith('@')) {
        gates.push(/^@media\b[^{]*\(hover:\s*hover\)/.test(head))
      } else {
        if (head.includes(':hover') && !gated) found.push(head)
        gates.push(false)
      }
      prelude = ''
    } else if (ch === '}') {
      gates.pop()
      prelude = ''
    } else if (ch === ';') {
      prelude = ''
    } else {
      prelude += ch
    }
  }
  return found
}

describe('touch rules', () => {
  it('catches an ungated :hover rule', () => {
    expect(ungatedHovers('.a:hover { color: red; }')).toEqual(['.a:hover'])
    expect(ungatedHovers('@media (min-width: 600px) { .a:hover { color: red; } }')).toEqual(['.a:hover'])
  })

  it('accepts a gated :hover rule', () => {
    const css = '@media (hover: hover) and (pointer: fine) { .a:hover { color: red; } }'
    expect(ungatedHovers(css)).toEqual([])
  })

  it('gates every :hover rule in the stylesheets', () => {
    const bad = stylesheets(src).flatMap((path) =>
      ungatedHovers(readFileSync(path, 'utf8')).map((sel) => `${relative(src, path)}: ${sel}`),
    )
    expect(bad).toEqual([])
  })

  it('sets the base touch rules in index.css', () => {
    const css = readFileSync(join(src, 'index.css'), 'utf8')
    expect(css).toMatch(/text-size-adjust:\s*100%/)
    expect(css).toMatch(/touch-action:\s*manipulation/)
  })
})
