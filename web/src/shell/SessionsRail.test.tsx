import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { mount, unmount } from './harness'

afterEach(() => {
  cleanup()
  unmount()
})

const failed = { body: { looked: 'failed', age_seconds: 0, error: 'tailscale did not answer' } }

describe('the sessions rail when its read fails', () => {
  it('says so in an inline error surface, with Try again, and not in a bare line', async () => {
    const asked = mount('desktop', '/', { overrides: { '/api/workspaces': failed } })
    const rail = await screen.findByRole('complementary', { name: 'Sessions' })
    const alert = await within(rail).findByRole('alert')
    expect(alert.getAttribute('data-layout')).toBe('inline')
    expect(within(alert).getByText('Sessions could not be read')).toBeTruthy()
    expect(within(alert).getByText('tailscale did not answer')).toBeTruthy()
    expect(rail.querySelector('.rail__note')).toBeNull()

    const before = asked.filter((one) => one === 'GET /api/workspaces').length
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(asked.filter((one) => one === 'GET /api/workspaces').length).toBeGreaterThan(before))
  })

  it('keeps the plain note for a read nobody has made yet', async () => {
    mount('desktop', '/', { overrides: { '/api/workspaces': { body: { looked: 'never' } } } })
    const rail = await screen.findByRole('complementary', { name: 'Sessions' })
    expect(await within(rail).findByText('Sessions have not been read yet.')).toBeTruthy()
    expect(within(rail).queryByRole('alert')).toBeNull()
  })
})
