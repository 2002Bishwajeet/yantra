import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Button } from '../button/Button'
import { Dialog, DialogClose, DialogPopup, DialogTrigger } from './Dialog'

function Kill() {
  const onKill = vi.fn()
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="text" tone="error" />}>Kill</DialogTrigger>
      <DialogPopup
        title="Kill landing?"
        description="The tmux session on macbook and every process in it end now."
        actions={
          <>
            <DialogClose render={<Button variant="text" />}>Cancel</DialogClose>
            <Button tone="error" onClick={onKill}>Kill</Button>
          </>
        }
      >
        <p>landing · macbook</p>
      </DialogPopup>
    </Dialog>
  )
}

describe('Dialog', () => {
  it('opens from its trigger as a named modal dialog and closes on Escape', async () => {
    render(<Kill />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    const dialog = await screen.findByRole('dialog', { name: 'Kill landing?' })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(screen.getByText('landing · macbook')).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('closes from Cancel', async () => {
    render(<Kill />)
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('moves focus inside on open and back to the trigger on Escape', async () => {
    render(<Kill />)
    const trigger = screen.getByRole('button', { name: 'Kill' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('closes on a click on the scrim', async () => {
    render(<Kill />)
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    await screen.findByRole('dialog')
    const scrim = document.querySelector('.m3-scrim')!
    fireEvent.pointerDown(scrim, { pointerType: 'mouse', button: 0 })
    fireEvent.mouseDown(scrim, { button: 0 })
    fireEvent.pointerUp(scrim, { pointerType: 'mouse', button: 0 })
    fireEvent.mouseUp(scrim, { button: 0 })
    fireEvent.click(scrim)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
