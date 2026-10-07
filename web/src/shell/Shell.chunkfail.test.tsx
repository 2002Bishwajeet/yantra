import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { mount, unmount } from './harness'

afterEach(() => {
  cleanup()
  unmount()
})


// A chunk that does not arrive: the import rejects.
vi.mock('./warm', () => ({}))
vi.mock('./Account', () => {
  throw new Error('chunk Account failed')
})
vi.mock('./BellPopover', () => {
  throw new Error('chunk BellPopover failed')
})
vi.mock('./Notifications', () => {
  throw new Error('chunk Notifications failed')
})

const navigation = () => screen.getByRole('navigation', { name: 'Main' })

describe('a popup chunk that fails to load', () => {
  it('says the avatar could not be drawn, and the desktop bar still draws', async () => {
    mount('desktop')
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }))
    expect(await screen.findByText('Account could not be drawn')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Account' })).toBeTruthy()
    expect(within(navigation()).getByRole('link', { name: 'Fleet' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Search anything/ })).toBeTruthy()
  })

  it('says the bell could not be drawn, and the desktop bar still draws', async () => {
    mount('desktop')
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
    expect(await screen.findByText('Notifications could not be drawn')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Notifications/ })).toBeTruthy()
    expect(within(navigation()).getByRole('link', { name: 'Fleet' })).toBeTruthy()
  })

  it('says the sheet list could not be drawn, and the tablet rail still draws', async () => {
    mount('tablet')
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
    expect(await screen.findByText('Notifications could not be drawn')).toBeTruthy()
    expect(within(navigation()).getByRole('link', { name: 'Fleet' })).toBeTruthy()
  })
})
