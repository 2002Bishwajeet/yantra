/**
 * The seed engine against palette-sage.json. Vitest loads this package through
 * Vite (`server.deps.inline` in vite.config.ts), because its own imports lack
 * `.js` and bare Node refuses them (R14 §2.1).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SAGE, applyScheme, clearScheme, roles, schemeFor } from './scheme'

const palette = JSON.parse(
  readFileSync(resolve(process.cwd(), '../docs/design/palette-sage.json'), 'utf8'),
) as { light: Record<string, string>; dark: Record<string, string> }

const kebab = (name: string) => name.toLowerCase().replace(/ /g, '-')

const gap = (a: string, b: string) =>
  Math.max(
    ...[1, 3, 5].map((i) =>
      Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)),
    ),
  )

/** The file's tertiary is at HCT tone 45 and its on-tertiary-container at 34,
 *  where Material's ladder puts 40 and 30, and its primary-container is at
 *  tone 89. No tonal palette can land those inside two units; these are the
 *  measured ceilings, so a regression in the fit still fails. */
const ceiling: Record<string, number> = {
  'primary-container': 3,
  'on-primary-container': 3,
  tertiary: 13,
  'on-tertiary': 9,
  'tertiary-container': 10,
  'on-tertiary-container': 10,
}

describe.each(['light', 'dark'] as const)('sage %s', (theme) => {
  const scheme = schemeFor(SAGE, theme === 'dark')

  it.each(Object.entries(palette[theme]))('%s is within reach of the file', (name, hex) => {
    const role = kebab(name)
    expect(gap(scheme[role as keyof typeof scheme], hex)).toBeLessThanOrEqual(ceiling[role] ?? 2)
  })

  it('fills every role, fixed ones included', () => {
    for (const role of roles) expect(scheme[role]).toMatch(/^#[0-9A-F]{6}$/)
  })
})

describe('another seed', () => {
  it('is an Expressive scheme and not sage', () => {
    const plum = schemeFor('#6B4E7A', false)
    expect(plum.primary).not.toBe(schemeFor(SAGE, false).primary)
    expect(plum['surface-container-high']).toMatch(/^#[0-9A-F]{6}$/)
  })
})

describe('applyScheme', () => {
  it('writes one light-dark() pair per role on the root and clears them', () => {
    const root = document.createElement('div')
    applyScheme(schemeFor(SAGE, false), schemeFor(SAGE, true), root)
    expect(root.style.getPropertyValue('--md-sys-color-primary')).toMatch(
      /^light-dark\(#[0-9A-F]{6}, #[0-9A-F]{6}\)$/,
    )
    expect(root.style.length).toBe(roles.length)
    clearScheme(root)
    expect(root.style.length).toBe(0)
  })
})
