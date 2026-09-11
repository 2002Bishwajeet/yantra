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
  readFileSync(resolve(process.cwd(), '../docs/design/palette-brass.json'), 'utf8'),
) as {
  light: Record<string, string>
  dark: Record<string, string>
  states: { light: Record<string, string>; dark: Record<string, string> }
}

const pair = (role: string, prefix = '--md-sys-color-') =>
  new RegExp(`${prefix}${role}: light-dark\\((#[0-9A-F]{6}), (#[0-9A-F]{6})\\);`).exec(css)

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const tiers = [
  'surface', 'surface-dim', 'surface-bright', 'surface-container-lowest', 'surface-container-low',
  'surface-container', 'surface-container-high', 'surface-container-highest',
]

const text: [string, string][] = [
  ...['primary', 'secondary', 'tertiary', 'error'].flatMap((g): [string, string][] => [
    [`on-${g}`, g],
    [`on-${g}-container`, `${g}-container`],
  ]),
  ...['primary', 'secondary', 'tertiary'].flatMap((g): [string, string][] => [
    [`on-${g}-fixed`, `${g}-fixed`],
    [`on-${g}-fixed-variant`, `${g}-fixed`],
  ]),
  ...tiers.flatMap((t): [string, string][] => [['on-surface', t], ['on-surface-variant', t]]),
  // Text buttons are drawn in `primary` on cards of these two (Y-383, axe on the dark dashboard).
  ['primary', 'primary-container'],
  ['primary', 'tertiary-container'],
  ['on-background', 'background'],
  ['inverse-on-surface', 'inverse-surface'],
]

describe('every colour role, both themes', () => {
  it.each(roles)('%s', (role) => {
    expect(pair(role)).toBeTruthy()
  })

  it.each(Object.keys(palette.light))('%s carries the file values', (name) => {
    const hit = pair(name.toLowerCase().replace(/ /g, '-'))!
    expect(hit[1]).toBe(palette.light[name])
    expect(hit[2]).toBe(palette.dark[name])
  })

  it('falls back to the light set where light-dark() is unknown', () => {
    const block = /@supports not \(color: light-dark\(#000, #fff\)\) \{[\s\S]*?\n\}/.exec(css)![0]
    for (const name of Object.keys(palette.light)) {
      const role = name.toLowerCase().replace(/ /g, '-')
      expect(block).toContain(`--md-sys-color-${role}: ${palette.light[name]};`)
    }
  })

  it.each(['light', 'dark'] as const)('%s: every text pair meets AA, 4.5:1', (theme) => {
    const at = theme === 'light' ? 1 : 2
    const hex = (role: string) => pair(role)![at]
    const failing = text
      .map(([fg, bg]) => [fg, bg, contrast(hex(fg), hex(bg)).toFixed(2)])
      .filter(([, , ratio]) => Number(ratio) < 4.5)
    expect(failing).toEqual([])
  })

  it('carries the five machine states, seed-independent and 3:1 on every tier', () => {
    for (const [theme, at] of [['light', 1], ['dark', 2]] as const) {
      for (const [state, hex] of Object.entries(palette.states[theme])) {
        expect(pair(state, '--yantra-state-')![at]).toBe(hex)
        for (const tier of [...tiers, 'primary-container']) {
          expect([state, tier, contrast(hex, pair(tier)![at]) >= 3]).toEqual([state, tier, true])
        }
      }
    }
    const block = /@supports not \(color: light-dark\(#000, #fff\)\) \{[\s\S]*?\n\}/.exec(css)![0]
    for (const [state, hex] of Object.entries(palette.states.light)) {
      expect(block).toContain(`--yantra-state-${state}: ${hex};`)
    }
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
    for (const curve of ['fast-spatial', 'default-spatial', 'effects']) {
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

  it('rings an inverse surface from the inverse palette', () => {
    expect(css).toContain(
      '[data-surface="inverse"] {\n  --md-sys-focus-ring-color: var(--md-sys-color-inverse-primary);\n}',
    )
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
