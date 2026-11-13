import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useBarScrolled } from './useBarScrolled'

describe('useBarScrolled', () => {
  const shell = () => document.querySelector('[data-shell]')!
  const scroll = (top: number) => {
    Object.defineProperty(window, 'scrollY', { value: top, configurable: true })
    window.dispatchEvent(new Event('scroll'))
  }

  beforeEach(() => {
    document.body.innerHTML = '<div data-shell="desktop"></div>'
    scroll(0)
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('sets the attribute past the top and removes it back at the top', () => {
    renderHook(() => useBarScrolled(true, '/'))
    scroll(40)
    expect(shell().hasAttribute('data-scrolled')).toBe(true)
    scroll(0)
    expect(shell().hasAttribute('data-scrolled')).toBe(false)
  })

  it('sets nothing while inactive', () => {
    renderHook(() => useBarScrolled(false, '/'))
    scroll(40)
    expect(shell().hasAttribute('data-scrolled')).toBe(false)
  })

  it('clears the attribute on unmount', () => {
    const { unmount } = renderHook(() => useBarScrolled(true, '/'))
    scroll(40)
    unmount()
    expect(shell().hasAttribute('data-scrolled')).toBe(false)
  })

  it('clears the attribute when the hook goes inactive', () => {
    const { rerender } = renderHook(({ on }) => useBarScrolled(on, '/'), { initialProps: { on: true } })
    scroll(40)
    rerender({ on: false })
    expect(shell().hasAttribute('data-scrolled')).toBe(false)
  })
})
