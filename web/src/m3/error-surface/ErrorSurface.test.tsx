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

describe('ErrorSurface headline', () => {
  it('draws the error’s own headline, and the caller’s title when it has none', () => {
    const own = new ApiError('refused', "a request from this machine's own address may not act", { status: 403 })
    const { unmount } = render(<ErrorSurface error={own} title="Events could not be read" />)
    expect(screen.getByRole('heading', { name: 'The proxy hides who is calling' })).toBeTruthy()
    expect(screen.queryByText('Events could not be read')).toBeNull()
    unmount()
    render(<ErrorSurface error={new ApiError('refused', 'node x is not yours', { status: 403 })} title="Events could not be read" />)
    expect(screen.getByRole('heading', { name: 'Events could not be read' })).toBeTruthy()
  })
})

describe('ErrorSurface', () => {
  it('draws one cause and one action, and keeps the raw words behind Details', () => {
    const reset = vi.fn()
    render(
      <ErrorSurface.Page
        eyebrow="Fleet"
        title="The daemon could not read the fleet"
        error={network}
        reset={reset}
        unknowns={['off the tailnet', 'yantrad down']}
        meta="last good read 2m ago"
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert.dataset.layout).toBe('page')
    expect(screen.getByText('The daemon did not answer.')).toBeTruthy()
    for (const hidden of ['fetch failed', 'last good read 2m ago']) expect(screen.queryByText(hidden)).toBeNull()
    expect(screen.queryAllByText('unknown')).toHaveLength(0)
    // The toggle and Try again: no second action.
    expect(screen.getAllByRole('button').map((one) => one.textContent)).toEqual(['Try again', 'Details'])

    const toggle = screen.getByRole('button', { name: 'Details' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeTruthy()
    expect(screen.getByText('fetch failed')).toBeTruthy()
    expect(screen.getAllByText('unknown')).toHaveLength(2)
    expect(screen.getByText('last good read 2m ago')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reset).toHaveBeenCalledOnce()
  })

  it('draws the caller action in place of Try again, never beside it', () => {
    render(
      <ErrorSurface.Page
        title="This device cannot reach Yantra"
        error={network}
        reset={() => {}}
        action={<Button>Open Tailscale</Button>}
      />,
    )
    expect(screen.getByRole('button', { name: 'Open Tailscale' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('draws no Details toggle when there is nothing behind it', () => {
    render(<ErrorSurface.Page title="No such machine" error={new ApiError('missing', '')} />)
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  })

  it('draws no Details toggle when the daemon said only what the sentence says', () => {
    const same = { kind: 'refused', said: ' It is gone. ', retryable: false, describe: () => 'It is gone.' }
    render(<ErrorSurface.Page title="Gone" error={same} />)
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  })

  it('draws Details when the daemon said more than the sentence does', () => {
    const more = { kind: 'refused', said: 'node x is not yours', retryable: false, describe: () => 'It is gone.' }
    render(<ErrorSurface.Page title="Gone" error={more} />)
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('node x is not yours')).toBeTruthy()
  })

  it('keeps the card whole: sentence, words, unknowns and both buttons, no toggle', () => {
    render(
      <ErrorSurface.Card
        title="Usage"
        error={network}
        reset={() => {}}
        unknowns={['off the tailnet']}
        action={<Button variant="text">Open Tailscale</Button>}
      />,
    )
    expect(screen.getByText('fetch failed')).toBeTruthy()
    expect(screen.getAllByText('unknown')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Tailscale' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  })

  it('draws the whole of a long inline sentence, wrapped and never clipped', () => {
    const said =
      '`mbp` runs macOS and has no tmux server, and Yantra will not start one there: panes in a server started over ssh cannot read the login keychain, so the agent would come up unauthenticated. Start one from a login session on that machine — in Terminal: `tmux new-session -d`'
    render(<ErrorSurface.Inline title="Starting was refused" error={new ApiError('refused', said, { status: 409 })} />)
    const span = screen.getByText(said)
    expect(span.className).not.toContain('m3-clip')
    expect(span.className).toContain('m3-wrap')
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

  // jsdom applies no stylesheet, so the rules are read as text (Y-721).
  it('rings only on :focus-visible, and a plain link rings in the shape of its control', () => {
    const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
    for (const path of ['src/m3/tokens.css', 'src/m3/error-surface/ErrorSurface.css', 'src/m3/button/Button.css']) {
      const bare = [...read(path).matchAll(/([^{}]*:focus(?!-visible)[^{}]*)\{([^}]*)\}/g)]
      expect(bare.filter(([, , body]) => /outline\s*:(?!\s*none)/.test(body!))).toEqual([])
    }
    const css = read('src/m3/tokens.css')
    const hit = css.match(/\.m3-hit:focus-visible\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(hit).toMatch(/outline:\s*var\(--md-sys-focus-ring-width\)/)
    expect(hit).toMatch(/outline-offset:\s*var\(--md-sys-focus-ring-offset\)/)
    expect(hit).toMatch(/border-radius:/)
  })

  it('folds a row’s raw words behind Details when asked', () => {
    const long = new ApiError('refused', 'node pi is on this tailnet but is not yours', { status: 403 })
    render(<ErrorSurface.Inline folded title="No code was made" error={long} />)
    const row = screen.getByRole('alert')
    expect(row.textContent).not.toContain('is not yours')
    const toggle = screen.getByRole('button', { name: 'Details' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('node pi is on this tailnet but is not yours')).toBeTruthy()
  })

  it('draws no Details on a folded row with no words to fold', () => {
    render(<ErrorSurface.Inline folded title="Transcript" error={new ApiError('network', '')} />)
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
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
