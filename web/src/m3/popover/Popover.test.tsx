import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Bell } from 'lucide-react'
import { IconButton } from '../icon-button/IconButton'
import { Popover, PopoverPopup, PopoverTrigger } from './Popover'

afterEach(cleanup)

describe('Popover', () => {
  it('opens a named dialog from its trigger and closes on Escape', async () => {
    render(
      <Popover>
        <PopoverTrigger render={<IconButton label="Notifications" />}>
          <Bell />
        </PopoverTrigger>
        <PopoverPopup title="Notifications">
          <p>You're caught up</p>
        </PopoverPopup>
      </Popover>,
    )
    const trigger = screen.getByRole('button', { name: 'Notifications' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    const popup = await screen.findByRole('dialog', { name: 'Notifications' })
    expect(screen.getByText("You're caught up")).toBeTruthy()
    fireEvent.keyDown(popup, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
