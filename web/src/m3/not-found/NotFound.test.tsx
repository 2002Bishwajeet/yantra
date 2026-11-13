import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { renderRouted } from '@/test/inRouter'
import { useScreenTitleOverride } from '@/shell/title'
import { NotFound } from './NotFound'

afterEach(cleanup)

function AppBar() {
  return <output data-testid="bar">{useScreenTitleOverride()}</output>
}

describe('NotFound', () => {
  it('names the missing thing, says one sentence and offers one tonal way out', async () => {
    await renderRouted(
      <NotFound headline="No machine is called box" label="Machines" to="/machines">
        The tailnet lists no node with that name.
      </NotFound>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Not found' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'No machine is called box' })).toBeTruthy()
    expect(screen.getByText('The tailnet lists no node with that name.')).toBeTruthy()
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe('/machines')
    expect(links[0]!.dataset.variant).toBe('tonal')
    expect(links[0]!.textContent).toBe('Machines')
  })

  it('is no alert, no card and has no Details', async () => {
    const { container } = await renderRouted(
      <NotFound headline="Nothing is at /x" label="Dashboard" to="/">
        Go back.
      </NotFound>,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
    expect(container.querySelector('.m3-card')).toBeNull()
  })

  it('titles the tab and the phone app bar, and puts the tab title back', async () => {
    document.title = 'Machine · Yantra'
    const { unmount } = await renderRouted(
      <>
        <AppBar />
        <NotFound headline="Nothing is at /x" label="Dashboard" to="/">
          Go back.
        </NotFound>
      </>,
    )
    await waitFor(() => expect(document.title).toBe('Not found · Yantra'))
    expect(screen.getByTestId('bar').textContent).toBe('Not found')
    unmount()
    expect(document.title).toBe('Machine · Yantra')
  })
})
