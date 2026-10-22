import { render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDockHeight } from './useDockHeight'

let notify: () => void = () => {}
const observed: Element[] = []
const disconnect = vi.fn()

class FakeObserver {
  constructor(callback: () => void) {
    notify = callback
  }
  observe(target: Element) {
    observed.push(target)
  }
  disconnect = disconnect
}

function Dock({ onResize }: { onResize?: (dock: HTMLElement) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDockHeight(ref, onResize)
  return (
    <div className="m3-page">
      <div ref={ref} />
    </div>
  )
}

const height = () => document.documentElement.style.getPropertyValue('--composer-dock-height')

afterEach(() => {
  vi.unstubAllGlobals()
  observed.length = 0
  disconnect.mockClear()
})

describe('useDockHeight', () => {
  it('writes the dock height when the observer fires, and clears it on unmount', () => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(132)
    const { unmount } = render(<Dock />)
    expect(height()).toBe('')
    notify()
    expect(height()).toBe('132px')
    unmount()
    expect(height()).toBe('')
    expect(disconnect).toHaveBeenCalled()
  })

  it('watches the dock and the page around it, and tells the caller after each measure', () => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    const onResize = vi.fn()
    render(<Dock onResize={onResize} />)
    expect(observed.map((one) => one.className)).toEqual(['', 'm3-page'])
    notify()
    expect(onResize).toHaveBeenCalledOnce()
  })

  it('does nothing where there is no ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    expect(() => render(<Dock />)).not.toThrow()
    expect(height()).toBe('')
  })
})
