import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useFabFocus } from './fabFocus'

/* Where focus goes when the FAB's action changes under a keyboard reader. The
   shell draws the FAB; this draws the three shapes it can take. */

type Kind = 'new' | 'add' | 'install' | null

function Page(props: { kind: Kind; status?: boolean }) {
  const { kind, status = true } = props
  const focus = useFabFocus(kind ?? 'none')
  const fab =
    kind === 'install' ? (
      <button className="shell__fab" onBlur={focus.onBlur} onFocus={focus.onFocus}>
        Install on pi-5
      </button>
    ) : kind ? (
      <a className="shell__fab" href={kind === 'new' ? '/new' : '/machines/add'} onBlur={focus.onBlur} onFocus={focus.onFocus}>
        {kind === 'new' ? 'New session' : 'Add a device'}
      </a>
    ) : null
  return (
    <>
      <main tabIndex={-1}>
        {status ? (
          <p data-fab-return="" tabIndex={-1}>
            installing on pi-5…
          </p>
        ) : null}
      </main>
      {fab}
    </>
  )
}

const fab = () => document.querySelector<HTMLElement>('.shell__fab')!

describe('focus on the FAB', () => {
  it('stays on the same element when one link action replaces another', () => {
    const { rerender } = render(<Page kind="new" />)
    const before = fab()
    before.focus()
    rerender(<Page kind="add" />)
    expect(fab()).toBe(before)
    expect(document.activeElement).toBe(before)
    expect(before.getAttribute('href')).toBe('/machines/add')
  })

  it('moves to the new FAB when a link becomes a button', () => {
    const { rerender } = render(<Page kind="add" />)
    fab().focus()
    rerender(<Page kind="install" />)
    expect(fab().tagName).toBe('BUTTON')
    expect(document.activeElement).toBe(fab())
  })

  it('moves to the page’s status line when the FAB goes away', () => {
    const { rerender } = render(<Page kind="install" />)
    fab().focus()
    rerender(<Page kind={null} />)
    expect(document.activeElement).toBe(screen.getByText('installing on pi-5…'))
  })

  it('moves to the page when there is no status line', () => {
    const { rerender } = render(<Page kind="install" status={false} />)
    fab().focus()
    rerender(<Page kind={null} status={false} />)
    expect(document.activeElement).toBe(screen.getByRole('main'))
  })

  it('leaves focus alone once the reader has moved it off the FAB', async () => {
    const { rerender } = render(<Page kind="add" />)
    fab().focus()
    fab().blur()
    await Promise.resolve()
    rerender(<Page kind="install" />)
    expect(document.activeElement).toBe(document.body)
  })

  it('does nothing for a reader who never focused the FAB', () => {
    const { rerender } = render(<Page kind="install" />)
    rerender(<Page kind={null} />)
    expect(document.activeElement).toBe(document.body)
  })
})
