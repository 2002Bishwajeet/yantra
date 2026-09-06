/**
 * tokens.css read as text: jsdom applies no stylesheet, and a role that stops
 * existing is otherwise silent.
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { roles } from './theme/scheme'

const css = readFileSync(resolve(process.cwd(), 'src/m3/tokens.css'), 'utf8')

const palette = JSON.parse(
  readFileSync(resolve(process.cwd(), '../docs/design/palette-sage.json'), 'utf8'),
) as { light: Record<string, string>; dark: Record<string, string> }

const pair = (role: string) =>
  new RegExp(`--md-sys-color-${role}: light-dark\\((#[0-9A-F]{6}), (#[0-9A-F]{6})\\);`).exec(css)

describe('every colour role, both themes', () => {
  it.each(roles)('%s', (role) => {
    expect(pair(role)).toBeTruthy()
  })

  it.each(Object.keys(palette.light))('%s carries the file values', (name) => {
    const hit = pair(name.toLowerCase().replace(/ /g, '-'))!
    expect(hit[1]).toBe(palette.light[name])
    expect(hit[2]).toBe(palette.dark[name])
  })

  it('is the root color-scheme that picks the theme', () => {
    expect(css).toContain(':root {\n  color-scheme: light dark;')
    expect(css).toContain('[data-theme="light"] {\n  color-scheme: light;')
    expect(css).toContain('[data-theme="dark"] {\n  color-scheme: dark;')
    expect(css).toContain(':root[data-theme="dark"],')
  })
})

describe('the other tokens', () => {
  it('has the shape scale with the Expressive steps', () => {
    for (const [name, px] of [
      ['none', 0], ['extra-small', 4], ['small', 8], ['medium', 12], ['large', 16],
      ['large-increased', 20], ['extra-large', 28], ['extra-large-increased', 32],
      ['extra-extra-large', 48], ['full', 9999],
    ]) {
      expect(css).toContain(`--md-sys-shape-corner-${name}: ${px}px;`)
    }
  })

  it('has fifteen type roles, each with an emphasized weight', () => {
    const sizes = [...css.matchAll(/--md-sys-typescale-([a-z-]+)-size: /g)].map((m) => m[1])
    expect(sizes).toHaveLength(15)
    for (const role of sizes) {
      expect(css).toContain(`--md-sys-typescale-emphasized-${role}-weight: `)
    }
    expect(css).toContain('--md-sys-typescale-display-large-size: 57px;')
    expect(css).toContain('--md-sys-typescale-body-medium-size: 14px;')
  })

  it('has four spring curves, their durations and the legacy table', () => {
    for (const curve of ['fast-spatial', 'default-spatial', 'standard-spatial', 'effects']) {
      expect(css).toMatch(new RegExp(`--md-sys-motion-spring-${curve}: linear\\(0, `))
    }
    expect(css).toContain('--md-sys-motion-duration-fast-spatial: 360ms;')
    expect(css).toContain('--md-sys-motion-duration-slow-effects: 327ms;')
    expect(css).toContain('--md-sys-motion-duration-extra-long4: 1000ms;')
    expect(css).toContain('--md-sys-motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);')
  })

  it('floors reduced motion at one frame and keeps the fades', () => {
    const rule = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/.exec(css)![0]
    expect(rule).toContain('--md-sys-motion-duration-fast-spatial: 1ms;')
    expect(rule).not.toContain('effects')
    expect(rule).not.toContain('display: none')
  })

  it('has state layers, the focus ring and the hit area', () => {
    expect(css).toContain('--md-sys-state-hover-state-layer-opacity: 0.08;')
    expect(css).toContain('--md-sys-state-focus-state-layer-opacity: 0.1;')
    expect(css).toContain('--md-sys-state-pressed-state-layer-opacity: 0.1;')
    expect(css).toContain('--md-sys-state-dragged-state-layer-opacity: 0.16;')
    expect(css).toContain('--md-sys-focus-ring-width: 3px;')
    expect(css).toContain('--md-sys-focus-ring-offset: 2px;')
    expect(css).toContain('--md-sys-focus-ring-color: var(--md-sys-color-secondary);')
    expect(css).toContain('--md-sys-hit-area: 48px;')
  })

  it('switches density on an attribute', () => {
    const compact = /\[data-density="compact"\] \{[\s\S]*?\n\}/.exec(css)![0]
    expect(compact).toContain('--m3-card-padding: 14px;')
    expect(compact).toContain('--m3-row-min-height: 40px;')
    expect(compact).toContain('--m3-list-gap: 4px;')
    expect(compact).toContain('--m3-tile-size: 28px;')
  })

  it('maps the roles onto Tailwind', () => {
    expect(css).toContain('--color-primary-container: var(--md-sys-color-primary-container);')
    expect(css).toContain('--color-on-surface: var(--md-sys-color-on-surface);')
    expect(css).toContain('--radius-xl: var(--md-sys-shape-corner-large);')
    expect(css).toContain('--font-mono: var(--md-ref-typeface-mono);')
  })
})

describe('fonts', () => {
  const files = [
    '@fontsource-variable/google-sans-flex/files/google-sans-flex-latin-wght-normal.woff2',
    '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
    '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2',
  ]

  it('declares the three latin faces with swap and nothing else', () => {
    for (const file of files) expect(css).toContain(`url("${file}")`)
    expect([...css.matchAll(/@font-face/g)]).toHaveLength(3)
    expect([...css.matchAll(/font-display: swap/g)]).toHaveLength(3)
    expect(css).not.toContain('-opsz-')
    expect(css).not.toContain('latin-ext')
  })

  /** ADR-0024 §7: 80 KiB for the fonts, measured on the files referenced. */
  it('fits the budget', () => {
    const bytes = files
      .map((file) => statSync(resolve(process.cwd(), 'node_modules', file)).size)
      .reduce((a, b) => a + b, 0)
    expect(bytes).toBeLessThanOrEqual(80 * 1024)
  })
})

describe('the seam', () => {
  it('does not import the colour engine', () => {
    expect(css).not.toMatch(/@import[^;]*scheme/)
    expect(css).not.toContain('material-color-utilities')
  })
})
