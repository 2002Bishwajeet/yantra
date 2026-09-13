import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Mark, State, type MarkState } from './Mark'
import { word } from './word'

const states: MarkState[] = ['needs', 'running', 'idle', 'unknown', 'done', 'failed']

// jsdom applies no stylesheet, so the forms and colours are read as text, as tokens.test.ts does.
const markCss = readFileSync(resolve(process.cwd(), 'src/m3/mark/Mark.css'), 'utf8')
const tokens = readFileSync(resolve(process.cwd(), 'src/m3/tokens.css'), 'utf8')

const rule = (selector: string) => {
  const at = markCss.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return markCss.slice(at, markCss.indexOf('}', at))
}

const hexes = (name: string) => {
  const m = new RegExp(`${name}: light-dark\\((#[0-9A-F]{6}), (#[0-9A-F]{6})\\);`).exec(tokens)
  expect(m, name).toBeTruthy()
  return { light: m![1], dark: m![2] }
}

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

/** The colour each mark is painted in. Unknown takes no state tint (D3 §6.2). */
const ink = (state: MarkState) =>
  hexes(state === 'unknown' ? '--md-sys-color-outline' : `--yantra-state-${state}`)

const surfaces = [
  'surface', 'surface-dim', 'surface-bright', 'surface-container-lowest', 'surface-container-low',
  'surface-container', 'surface-container-high', 'surface-container-highest', 'primary-container',
]

describe('the six forms', () => {
  /** A rule with every colour taken out: what a greyscale render still shows. */
  const form = (state: MarkState) => {
    const own = rule(`.m3-mark[data-state="${state}"]`)
      .replace(/var\(--(yantra-state|md-sys-color)-[a-z-]+\)/g, 'C')
      .replace(/\[data-state="[a-z]+"\]/, '')
    const angular = /\[data-state="([a-z]+)"\]/g
    const grown = [...rule('.m3-mark:is([data-state="needs"], [data-state="failed"])').matchAll(angular)]
      .map((m) => m[1])
    return own + (grown.includes(state) ? ' grown' : '')
  }

  it('gives every state its own form, colour removed (WCAG 1.4.1)', () => {
    expect(new Set(states.map(form)).size).toBe(states.length)
  })

  it('draws failed as a diamond, needs as a triangle, running as a disc', () => {
    expect(rule('.m3-mark[data-state="failed"]')).toContain('polygon(50% 0, 100% 50%, 50% 100%, 0 50%)')
    expect(rule('.m3-mark[data-state="needs"]')).toContain('polygon(50% 6.7%, 100% 93.3%, 0 93.3%)')
    expect(rule('.m3-mark[data-state="running"]')).not.toMatch(/clip-path|border/)
  })

  it('never colours the words', () => {
    expect(markCss).not.toMatch(/(^|[\s;{])color:/)
    for (const [, property] of markCss.matchAll(/([a-z-]+): [^;]*--yantra-state-/g)) {
      expect(['background', 'border']).toContain(property)
    }
  })
})

describe('mark contrast, computed from tokens.css (WCAG 1.4.11)', () => {
  it.each(['light', 'dark'] as const)('%s: every mark is 3:1 on every surface', (theme) => {
    const failing = states.flatMap((state) =>
      surfaces
        .map((bg) => [state, bg, contrast(ink(state)[theme], hexes(`--md-sys-color-${bg}`)[theme])] as const)
        .filter(([, , ratio]) => ratio < 3),
    )
    expect(failing).toEqual([])
  })

  it('paints failed in the container text on an error container, where its hex is too faint', () => {
    const container = hexes('--md-sys-color-error-container')
    expect(contrast(ink('failed').dark, container.dark)).toBeLessThan(3)
    expect(rule('[data-tone="error"] .m3-mark[data-state="failed"]')).toContain('background: currentColor')
    const text = hexes('--md-sys-color-on-error-container')
    for (const theme of ['light', 'dark'] as const) {
      expect(contrast(text[theme], container[theme])).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('State', () => {
  it.each(states)('%s carries its word beside the mark', (state) => {
    render(<State state={state} />)
    const el = screen.getByText(word[state])
    expect(el.dataset.state).toBe(state)
    const mark = el.querySelector('.m3-mark')!
    expect(mark.getAttribute('aria-hidden')).toBe('true')
    expect(mark.getAttribute('data-state')).toBe(state)
  })

  it('takes a longer word from the caller', () => {
    render(<State state="needs">waiting for trust · cachyos-g14</State>)
    expect(screen.getByText('waiting for trust · cachyos-g14')).toBeTruthy()
  })

  it('has a small size for a row', () => {
    render(<Mark state="running" size="small" data-testid="m" />)
    expect(screen.getByTestId('m').dataset.size).toBe('small')
  })
})
