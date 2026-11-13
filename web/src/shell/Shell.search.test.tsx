import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { mount, unmount } from './harness'
import type { FormFactor } from './formFactor'

vi.mock('./warm', () => ({}))

afterEach(() => {
  cleanup()
  unmount()
})

const drawn = async (size: FormFactor) => {
  mount(size)
  await screen.findAllByRole('heading', { level: 1, name: 'Dashboard' })
}
const press = (el: HTMLElement) => {
  act(() => el.focus())
  fireEvent.pointerDown(el)
  fireEvent.mouseDown(el)
  fireEvent.pointerUp(el)
  fireEvent.mouseUp(el)
  fireEvent.click(el)
}

describe.each<FormFactor>(['phone', 'tablet'])('the search button on %s', (size) => {
  it('opens Search with an empty field, and Escape gives the focus back', async () => {
    await drawn(size)
    const button = screen.getByRole('button', { name: 'Search' })
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    press(button)
    const dialog = await screen.findByRole('dialog', { name: 'Search' })
    const field = await screen.findByRole('combobox')
    expect((field as HTMLInputElement).value).toBe('')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(button))
  })
})

describe('the back button of the phone search view', () => {
  it('closes the view and gives the focus back to the search button', async () => {
    await drawn('phone')
    const button = screen.getByRole('button', { name: 'Search' })
    press(button)
    await screen.findByRole('dialog', { name: 'Search' })
    const back = await screen.findByRole('button', { name: 'Close search' })
    press(back)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(button))
  })
})

describe('the search button on the desktop', () => {
  it('is not drawn; the pill is', async () => {
    await drawn('desktop')
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull()
    expect(screen.getByText('Search anything')).toBeTruthy()
  })
})
