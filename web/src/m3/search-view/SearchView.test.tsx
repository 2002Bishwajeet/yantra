import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SearchView } from './SearchView'

afterEach(cleanup)

function Harness() {
  const [open, setOpen] = useState(true)
  const [value, setValue] = useState('')
  return (
    <SearchView input={{ role: 'combobox' }} onOpenChange={setOpen} onValueChange={setValue} open={open} value={value}>
      <p>results</p>
    </SearchView>
  )
}

describe('SearchView', () => {
  it('names the dialog Search and the field Search anything', () => {
    render(<Harness />)
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Search anything' })).toBeTruthy()
    expect(screen.getByText('results')).toBeTruthy()
  })

  it('shows the clear button only while the field has text', () => {
    render(<Harness />)
    const field = screen.getByRole('combobox') as HTMLInputElement
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
    fireEvent.change(field, { target: { value: 'a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(field.value).toBe('')
    expect(document.activeElement).toBe(field)
  })

  it('closes from the back button', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
