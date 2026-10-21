import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ContextRing } from './ContextRing'

afterEach(cleanup)

describe('the context ring', () => {
  it('is not drawn before the first usage event', () => {
    const { container } = render(<ContextRing usage={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows the share, and turns to the error colour above 90 percent', () => {
    const { container, rerender } = render(<ContextRing usage={{ used: 29149, max: 200000 }} />)
    expect(screen.getByRole('button', { name: 'Context window 15% used' })).toBeTruthy()
    expect(container.querySelector('.composer-ring')?.hasAttribute('data-over')).toBe(false)
    rerender(<ContextRing usage={{ used: 182000, max: 200000 }} />)
    expect(screen.getByRole('button', { name: 'Context window 91% used' })).toBeTruthy()
    expect(container.querySelector('.composer-ring')?.hasAttribute('data-over')).toBe(true)
  })

  it('opens a popover with the tokens used and the window', async () => {
    render(<ContextRing usage={{ used: 182000, max: 200000 }} />)
    fireEvent.click(screen.getByRole('button', { name: /^Context window/ }))
    const popup = await screen.findByRole('dialog', { name: 'Context window' })
    expect(popup.textContent).toContain('182k tokens')
    expect(popup.textContent).toContain('200k tokens')
    expect(popup.hasAttribute('data-over')).toBe(true)
  })
})
