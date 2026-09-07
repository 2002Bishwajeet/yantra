import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Skeleton } from './Skeleton'

describe('Skeleton', () => {
  it('is hidden from readers and shaped by a word', () => {
    render(<Skeleton shape="round" data-testid="s" />)
    const el = screen.getByTestId('s')
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.dataset.shape).toBe('round')
    expect(el.dataset.slot).toBe('skeleton')
  })
})
