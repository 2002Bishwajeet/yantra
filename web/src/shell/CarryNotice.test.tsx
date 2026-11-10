import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ApiError } from '@/api/errors'
import type { Arrived } from '@/lib/secure'
import { CarryNotice } from './CarryNotice'

describe('CarryNotice', () => {
  it.each<Arrived>([{ kind: 'none' }, { kind: 'arrived', kept: 2 }])('says nothing when the carry is $kind', (landed) => {
    const { container } = render(<CarryNotice landed={landed} />)
    expect(container.textContent).toBe('')
  })

  it('says a failed carry did not arrive, and a reload asks again', async () => {
    const reload = vi.fn()
    render(<CarryNotice landed={{ kind: 'failed', error: new ApiError('network', 'Failed to fetch') }} reload={reload} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    await screen.findByText(/did not arrive/)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('names why the take was refused', async () => {
    const refused = new ApiError('refused', 'tailscale whois did not answer', { status: 503 })
    render(<CarryNotice landed={{ kind: 'failed', error: refused }} />)
    await screen.findByText(new RegExp(`did not arrive: ${refused.describe()}`))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('says a lost carry is gone, and goes when dismissed', async () => {
    render(<CarryNotice landed={{ kind: 'lost' }} />)
    await screen.findByText(/are gone/)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
