import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { readPrefs } from '@/shell/prefs'
import { mountSettings, unmountSettings } from './harness'

afterEach(() => {
  cleanup()
  unmountSettings()
})

describe('Appearance', () => {
  it('writes the theme and the density, and the shell applies them', async () => {
    mountSettings('desktop', '/settings/appearance')
    fireEvent.click(await screen.findByRole('button', { name: 'Dark' }))
    expect(readPrefs().theme).toBe('dark')
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    fireEvent.click(screen.getByRole('button', { name: /^Compact/ }))
    expect(readPrefs().density).toBe('compact')
    await waitFor(() => expect(document.documentElement.dataset.density).toBe('compact'))
    expect(screen.getByRole('button', { name: /^Compact/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('writes a named seed, and the chips show the scheme the engine made from it', async () => {
    mountSettings('desktop', '/settings/appearance')
    expect((await screen.findByRole('button', { name: 'sage' })).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'terracotta' }))
    expect(readPrefs().seed).toBe('#A85B3C')
    expect(screen.getByRole('button', { name: 'terracotta' }).getAttribute('aria-pressed')).toBe('true')
    // The engine is lazy; the hex arrives once it has loaded.
    await waitFor(() => expect(screen.getAllByText(/^#[0-9A-F]{6}$/)).toHaveLength(5))
    const hexes = screen.getAllByText(/^#[0-9A-F]{6}$/).map((one) => one.textContent)
    expect(hexes).toHaveLength(5)
    expect(hexes[0]).not.toBe('#48674B')
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--md-sys-color-primary')).toContain('light-dark('))

    fireEvent.click(screen.getByRole('button', { name: 'sage' }))
    expect(readPrefs().seed).toBeNull()
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--md-sys-color-primary')).toBe(''))
  })

  it('takes a custom hex only once it is one', async () => {
    mountSettings('desktop', '/settings/appearance')
    const field = await screen.findByLabelText('Custom hex')
    fireEvent.change(field, { target: { value: '#12' } })
    expect(readPrefs().seed).toBeNull()
    expect(await screen.findByText('That is not a colour.')).toBeTruthy()
    fireEvent.change(field, { target: { value: '1a2b3c' } })
    expect(readPrefs().seed).toBe('#1A2B3C')
    expect(screen.queryByText('That is not a colour.')).toBeNull()
    // Typing sage's own value is sage: null, and no engine.
    fireEvent.change(field, { target: { value: '#48674b' } })
    expect(readPrefs().seed).toBeNull()
  })
})
