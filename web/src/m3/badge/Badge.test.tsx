import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Badge } from './Badge'

afterEach(cleanup)

describe('Badge', () => {
  it('is a dot with a label when there is no count', () => {
    render(<Badge label="new activity" />)
    const badge = screen.getByText('new activity').parentElement!
    expect(badge.dataset.size).toBe('small')
    expect(badge.querySelector('[aria-hidden]')).toBeNull()
  })

  it('draws the count and caps it', () => {
    render(<Badge label="3 unread" count={3} />)
    expect(screen.getByText('3').getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByText('3 unread').className).toBe('m3-sr-only')
    cleanup()
    render(<Badge label="many" count={120} />)
    expect(screen.getByText('99+')).toBeTruthy()
  })
})
