import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { mount, unmount } from './harness'
import { readPrefs } from './prefs'

afterEach(() => {
  cleanup()
  unmount()
})

async function open() {
  fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
  return within(await screen.findByRole('dialog', { name: 'Notifications' }))
}

describe('notifications on the desktop', () => {
  it('opens as a popover, newest first, with Answer on a trust prompt', async () => {
    mount('desktop')
    const popover = await open()
    const rows = await popover.findAllByRole('listitem')
    // The issue's `updated_at` is the newest instant in the fixtures.
    expect(rows[0]!.textContent).toContain('Issue assigned: yantra#118')
    expect(rows.at(-1)!.textContent).toContain('api is waiting for trust')
    const answer = popover.getByRole('link', { name: 'Answer' })
    expect(answer.getAttribute('href')).toBe('/w/api?view=chat')
    expect(popover.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings/notifications')
  })

  it('Mark all read moves the seen mark and empties Unread', async () => {
    mount('desktop')
    const popover = await open()
    await popover.findAllByRole('listitem')
    fireEvent.click(popover.getByRole('button', { name: 'Mark all read' }))
    expect(readPrefs().seenAt).toBe(1786471773)
    expect(JSON.parse(localStorage.getItem('yantra.prefs')!).seenAt).toBe(1786471773)
    expect(await popover.findByText('Nothing unread.')).toBeTruthy()
    // The GitHub items still count: they have no read state of their own.
    await waitFor(() => expect(screen.getByRole('button', { name: /Notifications\s*2 unread/ })).toBeTruthy())
    fireEvent.click(popover.getByRole('button', { name: 'All' }))
    expect((await popover.findAllByRole('listitem')).length).toBe(6)
  })
})
