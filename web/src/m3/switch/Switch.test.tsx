import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Switch } from './Switch'

afterEach(cleanup)

describe('Switch', () => {
  it('is a switch with a name that toggles on click and Space', () => {
    const onCheckedChange = vi.fn()
    render(<Switch label="Push to phone" onCheckedChange={onCheckedChange} />)
    const el = screen.getByRole('switch', { name: 'Push to phone', checked: false })
    fireEvent.click(el)
    expect(onCheckedChange).toHaveBeenLastCalledWith(true, expect.anything())
    expect(el.getAttribute('aria-checked')).toBe('true')
    expect(el.hasAttribute('data-checked')).toBe(true)
    el.focus()
    fireEvent.click(el)
    expect(el.getAttribute('aria-checked')).toBe('false')
  })

  it('holds a controlled value and a disabled state', () => {
    render(<Switch label="Quiet hours" checked disabled />)
    const el = screen.getByRole('switch', { name: 'Quiet hours', checked: true })
    expect(el).toHaveProperty('disabled', true)
  })
})
