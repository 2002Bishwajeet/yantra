import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HARNESSES } from '@/api/thread'
import { HarnessPicker } from './HarnessPicker'

describe('HarnessPicker', () => {
  it('draws a glyph of its own for each harness, since a phone shows no names', () => {
    const drawn = HARNESSES.map((harness) => {
      const { unmount } = render(<HarnessPicker locked={false} onChange={() => {}} value={harness} />)
      const svg = screen.getByRole('button', { name: /^Harness: / }).querySelector('svg')!
      unmount()
      return svg.getAttribute('class')
    })
    expect(new Set(drawn).size).toBe(HARNESSES.length)
  })
})
