import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Track } from './Track'

describe('Track', () => {
  it('is a progressbar with its value in percent, drawn as a scale', () => {
    render(<Track value={0.33} label="elapsed" />)
    const bar = screen.getByRole('progressbar', { name: 'elapsed' })
    expect(bar.getAttribute('aria-valuenow')).toBe('33')
    expect((bar.firstElementChild as HTMLElement).style.getPropertyValue('--m3-track-value')).toBe('0.33')
  })

  it('clamps', () => {
    render(<Track value={1.7} label="elapsed" />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
  })
})
