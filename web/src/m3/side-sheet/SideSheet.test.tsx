import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { SideSheet } from './SideSheet'

function Shell() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Bell
      </button>
      <SideSheet title="Notifications" open={open} onClose={() => setOpen(false)}>
        rows
      </SideSheet>
    </>
  )
}

describe('SideSheet', () => {
  it('is a named complementary region that closes from its button and Escape', () => {
    const onClose = vi.fn()
    render(
      <SideSheet title="Notifications" open onClose={onClose}>
        rows
      </SideSheet>,
    )
    const sheet = screen.getByRole('complementary', { name: 'Notifications' })
    expect(screen.getByRole('heading', { level: 2, name: 'Notifications' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close Notifications' }))
    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('is hidden when closed', () => {
    render(
      <SideSheet title="Notifications" open={false} onClose={() => {}}>
        rows
      </SideSheet>,
    )
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('takes focus on its title when opened, and gives it back on close', () => {
    render(<Shell />)
    const bell = screen.getByRole('button', { name: 'Bell' })
    bell.focus()
    fireEvent.click(bell)
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Notifications' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close Notifications' }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(document.activeElement).toBe(bell)
  })
})
