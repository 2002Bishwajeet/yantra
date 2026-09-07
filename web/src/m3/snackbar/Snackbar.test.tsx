import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Snackbar } from './Snackbar'

describe('Snackbar', () => {
  it('mounts the live region first and fills it a task later', async () => {
    const onClick = vi.fn()
    const onClose = vi.fn()
    render(
      <Snackbar action={{ label: 'Undo', onClick }} onClose={onClose}>
        landing stopped
      </Snackbar>,
    )
    const region = screen.getByRole('status')
    expect(region.textContent).toBe('')
    await screen.findByText('landing stopped')
    expect(region.textContent).toContain('landing stopped')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onClick).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('can interrupt as an alert', async () => {
    render(<Snackbar tone="alert">thinkpad unreachable</Snackbar>)
    expect(screen.getByRole('alert')).toBeTruthy()
    await screen.findByText('thinkpad unreachable')
  })
})
