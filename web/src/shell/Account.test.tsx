import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { REFUSED } from '@/lib/github'
import { renderRouted } from '@/test/inRouter'
import { AccountMenu } from './Account'

function draw(props: { login: string | null; refused?: boolean }) {
  const anchor = createRef<HTMLButtonElement>()
  return renderRouted(
    <>
      <button ref={anchor} type="button">
        Account
      </button>
      <AccountMenu
        anchor={anchor}
        login={props.login}
        onOpenChange={vi.fn()}
        open
        refused={props.refused ?? false}
        update={false}
      />
    </>,
  )
}

async function opened() {
  await screen.findByRole('menu')
  return screen.getAllByRole('menuitem').map((item) => item.textContent)
}

describe('the account line (Y-761)', () => {
  it('names the login and is not a menu item', async () => {
    await draw({ login: 'octocat' })
    const items = await opened()
    expect(screen.getByText('Signed in as octocat')).toBeTruthy()
    expect(items).toEqual(['Rooms', 'Settings', 'About'])
    expect(screen.getByRole('group', { name: 'Signed in as octocat' })).toBeTruthy()
  })

  it('says “This device” when there is no grant', async () => {
    await draw({ login: null })
    expect(await opened()).toEqual(['Rooms', 'Settings', 'About'])
    expect(screen.getByText('This device')).toBeTruthy()
  })

  it('keeps the refused line below the label', async () => {
    await draw({ login: 'octocat', refused: true })
    const items = await opened()
    expect(items[0]).toContain(REFUSED)
    const label = screen.getByText('Signed in as octocat')
    const refused = screen.getAllByRole('menuitem')[0]
    expect(label.compareDocumentPosition(refused) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('walks past the label with the arrow keys', async () => {
    await draw({ login: 'octocat' })
    const menu = await screen.findByRole('menu')
    const items = screen.getAllByRole('menuitem')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(items[0]))
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    await waitFor(() => expect(items).toContain(document.activeElement))
  })
})
