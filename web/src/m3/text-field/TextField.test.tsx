import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TextField } from './TextField'

afterEach(cleanup)

describe('TextField', () => {
  it('is a labelled textbox with its supporting line described', () => {
    const onValueChange = vi.fn()
    render(<TextField label="Name" supporting="a word pair is fine" onValueChange={onValueChange} />)
    const input = screen.getByRole('textbox', { name: 'Name' })
    expect(input.getAttribute('aria-describedby')).toBeTruthy()
    expect(screen.getByText('a word pair is fine')).toBeTruthy()
    fireEvent.change(input, { target: { value: 'yantra-web' } })
    expect(onValueChange).toHaveBeenLastCalledWith('yantra-web', expect.anything())
  })

  it('marks an error and says it', () => {
    render(<TextField label="Clone home" variant="filled" error="That folder is not on the machine." />)
    const input = screen.getByRole('textbox', { name: 'Clone home' })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('That folder is not on the machine.')).toBeTruthy()
    expect(input.closest('.m3-text-field')?.getAttribute('data-variant')).toBe('filled')
  })

  it('can be disabled', () => {
    render(<TextField label="Token" disabled />)
    expect(screen.getByRole('textbox', { name: 'Token' })).toHaveProperty('disabled', true)
  })
})
