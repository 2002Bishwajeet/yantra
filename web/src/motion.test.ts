/**
 * D3 §9 is written in numbers, and every one of them lives in `index.css` —
 * ADR-0014 says the diff when the design system lands is that file and nothing
 * else. So this reads the stylesheet rather than a rendered page: jsdom applies
 * no Tailwind, and a token that stopped existing is otherwise silent.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// From the vitest root rather than from `import.meta.url`, which the jsdom
// environment does not hand back as a file URL.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

/** D3 §9.1: five subsets shipped for an English interface. */
describe('the font is latin and nothing else', () => {
  it('declares the latin face and imports no subset it does not use', () => {
    expect(css).toContain('geist-latin-wght-normal.woff2')
    expect(css).not.toContain('@import "@fontsource-variable/geist"')
    for (const subset of ['cyrillic', 'cyrillic-ext', 'latin-ext', 'vietnamese']) {
      expect(css).not.toContain(`geist-${subset}-wght`)
    }
  })

  it('keeps the range the package declares, so no glyph changes', () => {
    expect(css).toContain('unicode-range: U+0000-00FF,U+0131,U+0152-0153')
  })
})

/** D3 §9.3, quoting design-system.md §6: one static frame, never nothing. */
describe('the reduced-motion floor', () => {
  const rule = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*$/.exec(css)?.[0]

  it('exists at all', () => {
    expect(rule).toBeTruthy()
  })

  it('holds a frame rather than blanking the visual', () => {
    expect(rule).toContain('animation-iteration-count: 1 !important')
    expect(rule).toContain('animation-duration: 1ms !important')
    expect(rule).toContain('transition-duration: 1ms !important')
    // Blanking is the regression this rule exists to avoid, so neither the
    // skeleton nor the spinner may be hidden to stop it moving.
    expect(rule).not.toContain('display: none')
    expect(rule).not.toContain('visibility: hidden')
    expect(rule).not.toContain('opacity: 0')
  })

  it('flattens the skeleton to its tint rather than removing it', () => {
    expect(rule).toContain('[data-slot="skeleton"]')
    expect(rule).toContain('background-image: none')
  })
})

/** D3 §9.2: motion exists only where something would otherwise teleport. */
describe('one duration and one easing', () => {
  it('names each once and spends them on every transition', () => {
    expect(css).toContain('--motion-duration: 150ms')
    expect(css).toContain('--motion-ease: cubic-bezier(0.2, 0, 0, 1)')
    expect(css).toContain('--default-transition-duration: var(--motion-duration)')
    expect(css).toContain(
      '--default-transition-timing-function: var(--motion-ease)',
    )
  })
})

/** D3 §5.4: a fifth size asks for a level of hierarchy §5.1 says is not there. */
describe('four type sizes', () => {
  it('names the four and no more', () => {
    expect(css).toContain('--text-meta: 0.75rem')
    expect(css).toContain('--text-body: 0.875rem')
    expect(css).toContain('--text-group: 1.125rem')
    expect(css).toContain('--text-title: 1.5rem')
    expect([...css.matchAll(/^\s*--text-[a-z]+:/gm)]).toHaveLength(4)
  })

  /** D3 §5.5: `font-variant-numeric: tabular-nums` fixes nothing, because Geist
   *  has no `tnum` feature. */
  it('grounds the mono face on the system stack', () => {
    expect(css).toContain('--font-mono: ui-monospace, SFMono-Regular, monospace')
    expect(css).not.toMatch(/font-variant-numeric:/)
  })
})

/** D3 §5.3's table, both columns. */
describe('two densities', () => {
  const wide = /@media \(width >= 48rem\) \{[\s\S]*?\n\}/.exec(css)?.[0] ?? ''

  it('holds the phone column', () => {
    expect(css).toContain('--page-width: calc(100% - 2rem)')
    expect(css).toContain('--row-height: 3.5rem')
    expect(css).toContain('--gutter: 1rem')
    expect(css).toContain('--group-gap: 1.5rem')
  })

  it('holds the wide column at 48rem', () => {
    expect(wide).toContain('--page-width: 72rem')
    expect(wide).toContain('--row-height: 2.5rem')
    expect(wide).toContain('--gutter: 2rem')
    expect(wide).toContain('--group-gap: 2rem')
  })

  it('reaches them through utilities rather than through a repeated number', () => {
    expect(css).toContain('--container-page: var(--page-width)')
    expect(css).toContain('--spacing-row: var(--row-height)')
    expect(css).toContain('--spacing-gutter: var(--gutter)')
    expect(css).toContain('--spacing-group: var(--group-gap)')
  })
})

/** D3 §6.1: four marks, so a greyscale render still separates the four. */
describe('the marks carry the state in form', () => {
  it('draws a dot for every tone and dashes only the unknown one', () => {
    expect(css).toContain('.mark::before')
    for (const tone of ['bad', 'warn', 'ok', 'idle', 'unknown']) {
      expect(css).toContain(`.tone-${tone}`)
    }
    expect(css).toMatch(/\.tone-unknown::before \{[^}]*border-style: dashed/)
  })

  /** D3 §6.2's two rules: unknown gets no tint, and the accent is never a
   *  state. Otherwise a crashed agent and a hyperlink end up the same colour. */
  it('tints three roles and leaves idle and unknown alone', () => {
    expect(css).toContain('--tone-critical: var(--destructive)')
    expect(css).toContain('--tone-warn: currentColor')
    expect(css).toContain('--tone-good: currentColor')
    expect(css).not.toMatch(/\.tone-(idle|unknown) \{[^}]*color:/)
    expect(css).not.toMatch(/--tone-[a-z]+: var\(--accent/)
  })
})
