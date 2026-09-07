import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Button } from '../button/Button'
import { BottomSheet, BottomSheetClose, BottomSheetPopup, BottomSheetTrigger } from './BottomSheet'

function Kill() {
  return (
    <BottomSheet>
      <BottomSheetTrigger render={<Button />}>Kill</BottomSheetTrigger>
      <BottomSheetPopup
        title="Kill landing?"
        actions={<BottomSheetClose render={<Button variant="text" />}>Cancel</BottomSheetClose>}
      >
        <p>landing · macbook</p>
      </BottomSheetPopup>
    </BottomSheet>
  )
}

describe('BottomSheet', () => {
  it('is a modal dialog with a handle that closes on Escape and from its button', async () => {
    render(<Kill />)
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    const sheet = await screen.findByRole('dialog', { name: 'Kill landing?' })
    expect(sheet.querySelector('.m3-bottom-sheet__handle')?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.keyDown(sheet, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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
    const sheet = await screen.findByRole('dialog')
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(sheet, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
