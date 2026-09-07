import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Bell } from 'lucide-react'
import { Lead } from './Lead'

afterEach(cleanup)

describe('Lead', () => {
  it('is decorative and toned', () => {
    render(
      <Lead tone="error" data-testid="l">
        <Bell />
      </Lead>,
    )
    const lead = screen.getByTestId('l')
    expect(lead.getAttribute('aria-hidden')).toBe('true')
    expect(lead.dataset.tone).toBe('error')
  })
})
