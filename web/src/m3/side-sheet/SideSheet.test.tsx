import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SideSheet } from './SideSheet'

afterEach(cleanup)

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
})
