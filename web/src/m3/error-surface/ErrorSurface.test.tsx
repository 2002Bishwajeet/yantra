import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ApiError } from '@/api/errors'
import { Button } from '../button/Button'
import { ErrorSurface } from './ErrorSurface'

afterEach(cleanup)

const network = new ApiError('network', 'fetch failed')

describe('ErrorSurface', () => {
  it('is an alert with the sentence, the words, the meta and both buttons', () => {
    const reset = vi.fn()
    render(
      <ErrorSurface.Page
        eyebrow="Fleet"
        title="Nothing here can be reached"
        error={network}
        reset={reset}
        unknowns={['off the tailnet', 'yantrad down']}
        meta="last good read 2m ago"
        action={<Button variant="text">Open Tailscale</Button>}
        autoFocus
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert.dataset.layout).toBe('page')
    expect(screen.getByText('The daemon did not answer.')).toBeTruthy()
    expect(screen.getByText('fetch failed')).toBeTruthy()
    expect(screen.getAllByText('unknown')).toHaveLength(2)
    expect(screen.getByText('last good read 2m ago')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Nothing here can be reached' }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reset).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Open Tailscale' })).toBeTruthy()
  })

  it('offers no Try again for an error that is not worth asking twice', () => {
    render(<ErrorSurface.Card title="Usage" error={new ApiError('refused', 'no', { status: 403 })} reset={() => {}} />)
    expect(screen.getByRole('alert').dataset.layout).toBe('card')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByText("This browser is not on a node this tailnet's owner holds.")).toBeTruthy()
  })

  it('has an inline row', () => {
    render(<ErrorSurface.Inline title="Transcript" error={network} />)
    expect(screen.getByRole('alert').dataset.layout).toBe('inline')
  })
})
