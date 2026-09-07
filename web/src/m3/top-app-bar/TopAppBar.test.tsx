import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ArrowLeft, Bell } from 'lucide-react'
import { IconButton } from '../icon-button/IconButton'
import { TopAppBar } from './TopAppBar'

describe('TopAppBar', () => {
  it('is a banner with the h1 and its actions', () => {
    render(
      <TopAppBar
        title="Dashboard"
        leading={
          <IconButton label="Back">
            <ArrowLeft />
          </IconButton>
        }
        actions={
          <IconButton label="Notifications">
            <Bell />
          </IconButton>
        }
      />,
    )
    expect(screen.getByRole('banner')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy()
  })
})
