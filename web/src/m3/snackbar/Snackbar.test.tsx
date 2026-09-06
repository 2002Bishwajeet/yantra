import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Snackbar } from './Snackbar'

afterEach(cleanup)

describe('Snackbar', () => {
  it('is a status with an action and a dismiss', () => {
    const onClick = vi.fn()
    const onClose = vi.fn()
    render(
      <Snackbar action={{ label: 'Undo', onClick }} onClose={onClose}>
        landing stopped
      </Snackbar>,
    )
    expect(screen.getByRole('status').textContent).toContain('landing stopped')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onClick).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('can interrupt as an alert', () => {
    render(<Snackbar tone="alert">thinkpad unreachable</Snackbar>)
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
