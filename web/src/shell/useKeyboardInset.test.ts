import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useKeyboardInset } from './useKeyboardInset'

class FakeViewport extends EventTarget {
  height = 800
  offsetTop = 0
}

const inset = () => document.documentElement.style.getPropertyValue('--m3-keyboard-inset')
const set = (vv: FakeViewport, height: number, offsetTop = 0, type = 'resize') => {
  vv.height = height
  vv.offsetTop = offsetTop
  vv.dispatchEvent(new Event(type))
}

describe('useKeyboardInset', () => {
  let vv: FakeViewport

  beforeEach(() => {
    vv = new FakeViewport()
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
    document.documentElement.style.removeProperty('--m3-keyboard-inset')
  })

  it('writes the keyboard height when the visual viewport shrinks', () => {
    renderHook(() => useKeyboardInset())
    expect(inset()).toBe('0px')
    set(vv, 500)
    expect(inset()).toBe('300px')
  })

  it('subtracts the pan so the inset is the gap under the visual viewport', () => {
    renderHook(() => useKeyboardInset())
    set(vv, 500, 100, 'scroll')
    expect(inset()).toBe('200px')
  })

  it('returns to 0 when the keyboard closes, and never goes negative', () => {
    renderHook(() => useKeyboardInset())
    set(vv, 500)
    set(vv, 800)
    expect(inset()).toBe('0px')
    set(vv, 800, 40)
    expect(inset()).toBe('0px')
  })

  it('does nothing without a visual viewport', () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
    expect(() => renderHook(() => useKeyboardInset())).not.toThrow()
    expect(inset()).toBe('')
  })

  it('removes the listeners and the property on unmount', () => {
    const { unmount } = renderHook(() => useKeyboardInset())
    set(vv, 500)
    unmount()
    expect(inset()).toBe('')
    set(vv, 400)
    expect(inset()).toBe('')
  })
})
