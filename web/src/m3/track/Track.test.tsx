import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Track } from './Track'

afterEach(cleanup)

describe('Track', () => {
  it('is a progressbar with its value in percent', () => {
    render(<Track value={0.33} label="elapsed" />)
    const bar = screen.getByRole('progressbar', { name: 'elapsed' })
    expect(bar.getAttribute('aria-valuenow')).toBe('33')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('33%')
  })

  it('clamps', () => {
    render(<Track value={1.7} label="elapsed" />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
  })
})
