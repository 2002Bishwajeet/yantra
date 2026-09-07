import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Bell } from 'lucide-react'
import { Button } from '../button/Button'
import { IconButton } from '../icon-button/IconButton'
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from './Popover'

function Bells(props: { showTitle?: boolean }) {
  return (
    <Popover>
      <PopoverTrigger render={<IconButton label="Notifications" />}>
        <Bell />
      </PopoverTrigger>
      <PopoverPopup title="Notifications" showTitle={props.showTitle}>
        <p>You're caught up</p>
        <PopoverClose render={<Button variant="text" />}>Done</PopoverClose>
      </PopoverPopup>
    </Popover>
  )
}

describe('Popover', () => {
  it('opens a named dialog from its trigger and closes on Escape', async () => {
    render(<Bells showTitle />)
    const trigger = screen.getByRole('button', { name: 'Notifications' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    const popup = await screen.findByRole('dialog', { name: 'Notifications' })
    expect(screen.getByText("You're caught up")).toBeTruthy()
    expect(screen.getByText('Notifications', { selector: '.m3-popover__title' })).toBeTruthy()
    fireEvent.keyDown(popup, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps its name for readers when the title is not drawn, and closes from PopoverClose', async () => {
    render(<Bells />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    await screen.findByRole('dialog', { name: 'Notifications' })
    expect(screen.getByText('Notifications', { selector: 'h2.m3-sr-only' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('moves focus into the popup on open and back to the trigger on Escape', async () => {
    render(<Bells />)
    const trigger = screen.getByRole('button', { name: 'Notifications' })
    trigger.focus()
    fireEvent.click(trigger)
    const popup = await screen.findByRole('dialog')
    await waitFor(() => expect(popup.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(popup, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
