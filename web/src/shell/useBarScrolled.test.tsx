import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useBarScrolled } from './useBarScrolled'

describe('useBarScrolled', () => {
  const shell = () => document.querySelector('[data-shell]')!
  const main = () => document.querySelector<HTMLElement>('.shell__main')!
  const scroll = (top: number) => {
    Object.defineProperty(window, 'scrollY', { value: top, configurable: true })
    window.dispatchEvent(new Event('scroll'))
  }
  const scrollMain = (top: number) => {
    main().scrollTop = top
    main().dispatchEvent(new Event('scroll'))
  }

  beforeEach(() => {
    document.body.innerHTML = '<div data-shell="desktop"><main class="shell__main"></main></div>'
    scroll(0)
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('sets the attribute past the top and removes it back at the top', () => {
    renderHook(() => useBarScrolled('desktop', '/'))
    scroll(40)
    expect(shell().hasAttribute('data-scrolled')).toBe(true)
    scroll(0)
    expect(shell().hasAttribute('data-scrolled')).toBe(false)
  })

  it('sets nothing on the tablet, which has no top bar', () => {
    renderHook(() => useBarScrolled('tablet', '/'))
    scroll(40)
    scrollMain(40)
    expect(shell().hasAttribute('data-scrolled')).toBe(false)
  })

  it('clears the attribute on unmount', () => {
    const { unmount } = renderHook(() => useBarScrolled('desktop', '/'))
    scroll(40)
    unmount()
    expect(shell().hasAttribute('data-scrolled')).toBe(false)
  })

  it('clears the attribute when the form factor leaves the bar', () => {
    const { rerender } = renderHook(({ factor }) => useBarScrolled(factor, '/'), {
      initialProps: { factor: 'desktop' as 'desktop' | 'tablet' },
    })
    scroll(40)
    rerender({ factor: 'tablet' })
    expect(shell().hasAttribute('data-scrolled')).toBe(false)
  })

  describe('on the phone, where main is the scroller', () => {
    it('sets the attribute when main scrolls, clears it back at 0, and ignores the window', () => {
      renderHook(() => useBarScrolled('phone', '/'))
      scroll(40)
      expect(shell().hasAttribute('data-scrolled')).toBe(false)
      scrollMain(40)
      expect(shell().hasAttribute('data-scrolled')).toBe(true)
      scrollMain(0)
      expect(shell().hasAttribute('data-scrolled')).toBe(false)
    })

    it('resets on a route change', () => {
      const { rerender } = renderHook(({ path }) => useBarScrolled('phone', path), {
        initialProps: { path: '/a' },
      })
      scrollMain(40)
      expect(shell().hasAttribute('data-scrolled')).toBe(true)
      main().scrollTop = 0
      rerender({ path: '/b' })
      expect(shell().hasAttribute('data-scrolled')).toBe(false)
    })
  })

  it('tones the phone bar and the status strip to surface-container (CSS read as text)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/shell/Shell.css'), 'utf8')
    const rule = /\[data-shell="phone"\]\[data-scrolled\] \.m3-top-app-bar,\s*\[data-shell="phone"\]\[data-scrolled\]\.shell::before \{([^}]*)\}/.exec(css)
    expect(rule?.[1]).toContain('background-color: var(--md-sys-color-surface-container);')
    expect(rule?.[1]).not.toContain('shadow')
  })
})
