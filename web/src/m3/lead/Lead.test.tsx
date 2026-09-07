import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Bell } from 'lucide-react'
import { Lead } from './Lead'

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
