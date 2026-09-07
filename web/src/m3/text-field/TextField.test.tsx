import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Search, X } from 'lucide-react'
import { IconButton } from '../icon-button/IconButton'
import { TextField } from './TextField'

const describedBy = (input: HTMLElement) =>
  (input.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)!)

describe('TextField', () => {
  it('is a labelled textbox whose supporting line describes it', () => {
    const onValueChange = vi.fn()
    render(<TextField label="Name" supporting="a word pair is fine" onValueChange={onValueChange} />)
    const input = screen.getByRole('textbox', { name: 'Name' })
    expect(describedBy(input).map((el) => el.textContent)).toEqual(['a word pair is fine'])
    fireEvent.change(input, { target: { value: 'yantra-web' } })
    expect(onValueChange).toHaveBeenLastCalledWith('yantra-web', expect.anything())
  })

  it('marks an error, says it in the described line, and drops the supporting line for it', () => {
    render(
      <TextField
        label="Clone home"
        variant="filled"
        supporting="a folder on the machine"
        error="That folder is not on the machine."
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Clone home' })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(describedBy(input).map((el) => el.textContent)).toEqual(['That folder is not on the machine.'])
    expect(screen.queryByText('a folder on the machine')).toBeNull()
    expect(input.closest('.m3-text-field')?.getAttribute('data-variant')).toBe('filled')
  })

  it('draws a leading icon and a trailing button that keeps its own name', () => {
    const onClear = vi.fn()
    render(
      <TextField
        label="Search repositories"
        leading={<Search data-testid="lead" />}
        trailing={
          <IconButton label="Clear" onClick={onClear}>
            <X />
          </IconButton>
        }
      />,
    )
    expect(screen.getByTestId('lead').parentElement?.className).toBe('m3-text-field__leading')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledOnce()
    expect(screen.getByRole('textbox', { name: 'Search repositories' })).toBeTruthy()
  })

  it('can be disabled', () => {
    render(<TextField label="Token" disabled />)
    expect(screen.getByRole('textbox', { name: 'Token' })).toHaveProperty('disabled', true)
  })
})
