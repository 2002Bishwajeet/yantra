import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Bell } from 'lucide-react'
import { Badge } from '../badge/Badge'
import { IconButton } from './IconButton'

afterEach(cleanup)

describe('IconButton', () => {
  it('takes its name from the label and hides the icon', () => {
    render(
      <IconButton label="Notifications">
        <Bell />
      </IconButton>,
    )
    const button = screen.getByRole('button', { name: 'Notifications' })
    expect(button.querySelector('svg')?.closest('[aria-hidden="true"]')).toBeTruthy()
    expect(button.dataset.variant).toBe('standard')
  })

  it('carries a badge inside the name', () => {
    render(
      <IconButton label="Notifications" variant="tonal" badge={<Badge count={3} label="3 unread" />}>
        <Bell />
      </IconButton>,
    )
    expect(screen.getByRole('button', { name: /Notifications.*3 unread/ })).toBeTruthy()
  })

  it('is keyboard reachable and quiet when disabled', () => {
    const onClick = vi.fn()
    render(
      <IconButton label="Close" onClick={onClick}>
        <Bell />
      </IconButton>,
    )
    const button = screen.getByRole('button', { name: 'Close' })
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
    cleanup()
    render(
      <IconButton label="Close" disabled onClick={onClick}>
        <Bell />
      </IconButton>,
    )
    expect(screen.getByRole('button', { name: 'Close' })).toHaveProperty('disabled', true)
  })
})
