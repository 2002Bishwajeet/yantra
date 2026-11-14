import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Select } from './Select'

afterEach(cleanup)

const OPTIONS = [
  { value: '', label: 'None' },
  { value: 'pi', label: 'pi' },
  { value: 'mac', label: 'mac' },
]

function mount(value = '', onValueChange = vi.fn()) {
  render(<Select label="Default machine" onValueChange={onValueChange} options={OPTIONS} value={value} />)
  return onValueChange
}

describe('Select', () => {
  it('names itself from the label and shows the chosen value', () => {
    mount('pi')
    const trigger = screen.getByRole('combobox', { name: 'Default machine' })
    expect(trigger.textContent).toBe('pi')
  })

  it('calls onValueChange with the item picked', async () => {
    const onValueChange = mount()
    fireEvent.click(screen.getByRole('combobox', { name: 'Default machine' }))
    const item = await screen.findByRole('option', { name: 'mac' })
    fireEvent.pointerDown(item)
    fireEvent.click(item)
    expect(onValueChange).toHaveBeenCalledWith('mac')
  })

  it('marks the selected item with a check', async () => {
    mount('pi')
    fireEvent.click(screen.getByRole('combobox', { name: 'Default machine' }))
    const chosen = await screen.findByRole('option', { name: 'pi' })
    expect(chosen.querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'mac' }).querySelector('svg')).toBeNull()
  })

  it('picks with the arrow keys and Enter', async () => {
    const onValueChange = mount('')
    const trigger = screen.getByRole('combobox', { name: 'Default machine' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await screen.findByRole('option', { name: 'pi' })
    const list = screen.getByRole('listbox')
    await waitFor(() => expect(list.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith('pi'))
  })
})
