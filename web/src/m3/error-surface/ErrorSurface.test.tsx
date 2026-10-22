import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ApiError } from '@/api/errors'
import { Button } from '../button/Button'
import { Page } from '../page/Page'
import { PageHeader } from '../page/PageHeader'
import { ErrorSurface } from './ErrorSurface'

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
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert.dataset.layout).toBe('page')
    expect(screen.getByText('The daemon did not answer.')).toBeTruthy()
    expect(screen.getByText('fetch failed')).toBeTruthy()
    expect(screen.getAllByText('unknown')).toHaveLength(2)
    expect(screen.getByText('last good read 2m ago')).toBeTruthy()
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

  it('draws under the PageHeader, so the title stays, with the failing read as its eyebrow', () => {
    render(
      <Page>
        <PageHeader title="Fleet" />
        <ErrorSurface.Page eyebrow="Fleet read" error={network} reset={() => {}} title="Nothing here can be reached" />
      </Page>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Fleet' })).toBeTruthy()
    const alert = screen.getByRole('alert')
    expect(alert.closest('.m3-page')).toBeTruthy()
    expect(alert.querySelector('.m3-eyebrow')?.textContent).toBe('Fleet read')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  // jsdom applies no stylesheet, so the rule is read as text.
  it('sets the page surface text in a measure, and keeps the surface on the page edges', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/m3/error-surface/ErrorSurface.css'), 'utf8')
    const block = (selector: string) => css.match(new RegExp(`${selector.replace(/[[\]".]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
    expect(block('.m3-error[data-layout="page"]')).not.toMatch(/max-inline-size/)
    expect(block('.m3-error[data-layout="page"] .m3-error__text')).toMatch(/max-inline-size:\s*var\(--m3-measure\)/)
  })

  it('has an inline row', () => {
    render(<ErrorSurface.Inline title="Transcript" error={network} />)
    expect(screen.getByRole('alert').dataset.layout).toBe('inline')
  })

  it.each(['Page', 'Card', 'Inline'] as const)('announces %s once: one live region, no focus move', (which) => {
    const Surface = ErrorSurface[which]
    render(<Surface title="Nothing here can be reached" error={network} />)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    const title = screen.getByRole('heading', { name: 'Nothing here can be reached' })
    expect(title.hasAttribute('tabindex')).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })
})
