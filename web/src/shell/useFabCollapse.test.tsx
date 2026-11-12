import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useFabCollapse } from './useFabCollapse'

describe('useFabCollapse', () => {
  let main: HTMLElement
  const shell = () => main.closest('[data-shell]')!
  const scroll = (top: number) => {
    main.scrollTop = top
    main.dispatchEvent(new Event('scroll'))
  }

  beforeEach(() => {
    document.body.innerHTML = '<div data-shell="phone"><main class="shell__main"></main></div>'
    main = document.querySelector('.shell__main')!
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('collapses on scroll down and expands on scroll up and at the top', () => {
    renderHook(() => useFabCollapse(true, '/'))
    scroll(120)
    expect(shell().hasAttribute('data-fab-collapsed')).toBe(true)
    scroll(100)
    expect(shell().hasAttribute('data-fab-collapsed')).toBe(false)
    scroll(300)
    expect(shell().hasAttribute('data-fab-collapsed')).toBe(true)
    scroll(0)
    expect(shell().hasAttribute('data-fab-collapsed')).toBe(false)
  })

  it('does nothing while there is no FAB', () => {
    renderHook(() => useFabCollapse(false, '/'))
    scroll(120)
    expect(shell().hasAttribute('data-fab-collapsed')).toBe(false)
  })
})
