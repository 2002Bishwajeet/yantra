import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Chip, FilterChip } from './Chip'

afterEach(cleanup)

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
  it('toggles with a click and with Space, and reports it', () => {
    const onPressedChange = vi.fn()
    render(<FilterChip onPressedChange={onPressedChange}>Running</FilterChip>)
    const chip = screen.getByRole('button', { name: 'Running', pressed: false })
    fireEvent.click(chip)
    expect(onPressedChange).toHaveBeenLastCalledWith(true, expect.anything())
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(chip.hasAttribute('data-pressed')).toBe(true)
    chip.focus()
    fireEvent.keyDown(chip, { key: ' ' })
    fireEvent.keyUp(chip, { key: ' ' })
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
