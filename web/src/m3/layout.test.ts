/**
 * A screen draws its layout from the page tokens (tokens.css): the radius, the
 * width and the big gaps are token reads, and the shape of the page is `Page`
 * and `PageHeader`. This reads every screen and shell stylesheet as text,
 * because jsdom applies no stylesheet and a literal that creeps back in is
 * otherwise silent.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = resolve(process.cwd(), 'src')

/** Gaps up to this many px are the small spacing inside a component, and 259
 *  of them are literal today. A larger one is a space between blocks of the
 *  page, which a token owns. The Y-566 row and web/README.md say the same. */
const SMALL_GAP = 16

function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return stylesheets(path)
    return path.endsWith('.css') ? [path] : []
  })
}

/** What a stylesheet may not say, one string per offence. */
export function offences(css: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const found: string[] = []
  for (const [, prop, value] of bare.matchAll(
    /(?:^|[;{\s])(border(?:-[a-z]+){0,2}-radius|max-width|max-inline-size|(?:row-|column-)?gap)\s*:\s*([^;}]+)/g,
  )) {
    const px = [...value!.matchAll(/(\d*\.?\d+)px/g)].map((one) => Number(one[1]))
    // ch, rem and em are still literals: a measure is a token too.
    const literal = /^\d*\.?\d+(?:px|ch|rem|em)$/.test(value!.trim())
    if (prop!.endsWith('radius')) {
      if (px.length > 0) found.push(`${prop}: ${value!.trim()}`)
    } else if (prop === 'max-width' || prop === 'max-inline-size') {
      // A bare length is a width; a calc against the viewport is a bound.
      if (literal) found.push(`${prop}: ${value!.trim()}`)
    } else if (px.some((one) => one > SMALL_GAP)) found.push(`${prop}: ${value!.trim()}`)
  }
  return found
}

describe('offences', () => {
  it('flags a literal radius, a literal max width and a literal gap above 16 px', () => {
    expect(offences('.a { border-radius: 22px; }')).toEqual(['border-radius: 22px'])
    expect(offences('.a { border-top-left-radius: var(--x, 12px); }')).toHaveLength(1)
    expect(offences('.a { max-width: 640px; }')).toEqual(['max-width: 640px'])
    expect(offences('.a { max-width: 60ch; }')).toEqual(['max-width: 60ch'])
    expect(offences('.a { max-inline-size: 40rem; }')).toEqual(['max-inline-size: 40rem'])
    expect(offences('.a { max-width: calc(100vw - 120px); }')).toEqual([])
    expect(offences('.a { gap: 24px; }')).toEqual(['gap: 24px'])
    expect(offences('.a { gap: 8px 40px; }')).toHaveLength(1)
    expect(offences('.a { column-gap: 20px; }')).toHaveLength(1)
  })

  it('lets a token, a relative unit, a small gap and a media query through', () => {
    expect(
      offences(`
        .a { border-radius: var(--md-sys-shape-corner-large); max-width: var(--m3-page-max-reading); }
        .b { max-width: 100%; max-inline-size: var(--m3-measure); gap: 8px 16px; border-radius: 50%; }
        /* border-radius: 99px; */
        @media (max-width: 599px) { .c { gap: var(--m3-gutter); } }
      `),
    ).toEqual([])
  })
})

describe('every screen and shell stylesheet', () => {
  const files = [...stylesheets(join(src, 'screens')), ...stylesheets(join(src, 'shell'))]

  it('finds the stylesheets it is meant to read', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(files.map((file) => [relative(src, file), file]))('%s draws no literal radius, max width or big gap', (_name, file) => {
    expect(offences(readFileSync(file!, 'utf8'))).toEqual([])
  })
})
