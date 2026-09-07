import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Chip, FilterChip } from './Chip'

describe('Chip', () => {
  it('is a label with a tone', () => {
    render(<Chip tone="error">unreachable</Chip>)
    const chip = screen.getByText('unreachable')
    expect(chip.tagName).toBe('SPAN')
    expect(chip.dataset.tone).toBe('error')
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('FilterChip', () => {
  /** A native button: Space and Enter are the browser's, which jsdom does
   *  not play, so the click is what this proves. */
  it('toggles with a click, and reports it', () => {
    const onPressedChange = vi.fn()
    render(<FilterChip onPressedChange={onPressedChange}>Running</FilterChip>)
    const chip = screen.getByRole('button', { name: 'Running', pressed: false })
    fireEvent.click(chip)
    expect(onPressedChange).toHaveBeenLastCalledWith(true, expect.anything())
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(chip.hasAttribute('data-pressed')).toBe(true)
    expect(chip.tagName).toBe('BUTTON')
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('false')
  })

  it('can be controlled and disabled', () => {
    render(
      <FilterChip pressed disabled>
        Idle
      </FilterChip>,
    )
    const chip = screen.getByRole('button', { name: 'Idle', pressed: true })
    expect(chip).toHaveProperty('disabled', true)
  })
})
