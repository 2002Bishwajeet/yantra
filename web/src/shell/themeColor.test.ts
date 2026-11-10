/**
 * index.html and tokens.css read as text: jsdom loads neither, and a meta tag
 * that drifts from the surface token is otherwise silent.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { paintThemeColor, syncThemeColor } from './themeColor'

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
const css = readFileSync(resolve(process.cwd(), 'src/m3/tokens.css'), 'utf8')

const metas = [
  ...html.matchAll(/<meta\s+name="theme-color"\s+media="\(prefers-color-scheme: (light|dark)\)"\s+data-scheme="\1"\s+content="(#[0-9A-Fa-f]{6})"\s*\/?>/g),
]

describe('index.html', () => {
  it('draws under the notch', () => {
    expect(html).toMatch(/<meta name="viewport"[^>]*viewport-fit=cover/)
  })

  it('lets the keyboard resize the layout viewport', () => {
    expect(html).toMatch(/<meta name="viewport"[^>]*viewport-fit=cover[^>]*interactive-widget=resizes-content/)
  })

  it('has exactly one theme-color meta per scheme', () => {
    expect(html.match(/<meta\s+name="theme-color"/g)).toHaveLength(2)
    expect(metas.map((m) => m[1]).sort()).toEqual(['dark', 'light'])
  })

  it('matches each theme-color to the surface token', () => {
    const surface = css.match(/--md-sys-color-surface:\s*light-dark\((#[0-9A-Fa-f]{6}),\s*(#[0-9A-Fa-f]{6})\)/)
    expect(surface).not.toBeNull()
    const [, light, dark] = surface!
    const by = Object.fromEntries(metas.map((m) => [m[1], m[2]!.toLowerCase()]))
    expect(by.light).toBe(light!.toLowerCase())
    expect(by.dark).toBe(dark!.toLowerCase())
  })

  it('puts the metas before the inline script', () => {
    expect(html.lastIndexOf('<meta name="theme-color"')).toBeLessThan(html.indexOf('<script>'))
  })

  it('rewrites the metas in the explicit-theme branch', () => {
    expect(html).toMatch(/data-scheme[\s\S]*p\.theme[\s\S]*not all/)
  })
})

describe('manifest.webmanifest', () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'public/manifest.webmanifest'), 'utf8'))
  const surface = css.match(/--md-sys-color-surface:\s*light-dark\((#[0-9A-Fa-f]{6}),\s*(#[0-9A-Fa-f]{6})\)/)!

  it('colours the splash and the title bar like the light surface, and like the dark one under color_scheme.dark', () => {
    const [, light, dark] = surface
    const night = manifest.user_preferences.color_scheme.dark
    expect([manifest.background_color, manifest.theme_color]).toEqual([light!.toUpperCase(), light!.toUpperCase()])
    expect([night.background_color, night.theme_color]).toEqual([dark!.toUpperCase(), dark!.toUpperCase()])
  })
})

describe('paintThemeColor', () => {
  const content = () =>
    [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content)

  beforeEach(() => {
    document.head.innerHTML =
      '<meta name="theme-color" data-scheme="light" content="#F6F0E2">' +
      '<meta name="theme-color" data-scheme="dark" content="#151714">'
  })
  afterEach(() => {
    document.head.innerHTML = ''
  })

  it('writes the seeded surface into each meta', () => {
    paintThemeColor({ light: '#EEF4FF', dark: '#101820' })
    expect(content()).toEqual(['#EEF4FF', '#101820'])
  })

  it('restores brass when the seed clears', () => {
    paintThemeColor({ light: '#EEF4FF', dark: '#101820' })
    paintThemeColor(null)
    expect(content()).toEqual(['#F6F0E2', '#151714'])
  })

  it('does nothing when the page has no metas', () => {
    document.head.innerHTML = ''
    expect(() => paintThemeColor(null)).not.toThrow()
  })
})

describe('syncThemeColor', () => {
  const media = (scheme: string) =>
    document.head.querySelector<HTMLMetaElement>(`meta[name="theme-color"][data-scheme="${scheme}"]`)!.media

  beforeEach(() => {
    document.head.innerHTML =
      '<meta name="theme-color" media="(prefers-color-scheme: light)" data-scheme="light" content="#F6F0E2">' +
      '<meta name="theme-color" media="(prefers-color-scheme: dark)" data-scheme="dark" content="#151714">'
  })
  afterEach(() => {
    document.head.innerHTML = ''
  })

  it('keeps only the light meta for light', () => {
    syncThemeColor('light')
    expect([media('light'), media('dark')]).toEqual(['all', 'not all'])
  })

  it('keeps only the dark meta for dark', () => {
    syncThemeColor('dark')
    expect([media('light'), media('dark')]).toEqual(['not all', 'all'])
  })

  it('returns to the OS scheme for system', () => {
    syncThemeColor('dark')
    syncThemeColor('system')
    expect([media('light'), media('dark')]).toEqual([
      '(prefers-color-scheme: light)',
      '(prefers-color-scheme: dark)',
    ])
  })

  it('does nothing when the page has no metas', () => {
    document.head.innerHTML = ''
    expect(() => syncThemeColor('dark')).not.toThrow()
  })
})
