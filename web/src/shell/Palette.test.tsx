import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { mount, unmount } from './harness'

afterEach(() => {
  cleanup()
  unmount()
})

async function open() {
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  const dialog = await screen.findByRole('dialog', { name: 'Search' })
  return within(dialog)
}

describe('the command palette', () => {
  it('opens with Ctrl-K and from the search pill', async () => {
    mount('desktop')
    await screen.findByRole('button', { name: /Search anything/ })
    const dialog = await open()
    expect(dialog.getByRole('combobox')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /Search anything/ }))
    expect(await screen.findByRole('dialog', { name: 'Search' })).toBeTruthy()
  })

  it('finds a workspace, highlights the match, and Enter opens its chat', async () => {
    mount('desktop')
    await screen.findByRole('button', { name: /Search anything/ })
    const dialog = await open()
    await dialog.findByRole('option', { name: /api/ })
    fireEvent.change(dialog.getByRole('combobox'), { target: { value: 'sit' } })
    const option = await dialog.findByRole('option', { name: /site/ })
    expect(option.querySelector('mark')?.textContent).toBe('sit')
    expect(dialog.queryByRole('option', { name: /Dashboard/ })).toBeNull()
    fireEvent.keyDown(dialog.getByRole('combobox'), { key: 'Enter' })
    await waitFor(() => expect(location.pathname + location.search).toBe('/w/site?view=chat'))
  })

  it('lists machines and pages too', async () => {
    mount('desktop')
    await screen.findByRole('button', { name: /Search anything/ })
    const dialog = await open()
    expect(await dialog.findByRole('group', { name: 'Machines' })).toBeTruthy()
    expect(dialog.getByRole('group', { name: 'Pages' })).toBeTruthy()
    expect(dialog.getByText('Finds a workspace, a machine or a page. Never runs a verb.')).toBeTruthy()
  })

  /** D3 §3.2: every entry the palette offers is opened, and the daemon is
   *  asked for nothing but readings. */
  it('never runs a verb', async () => {
    const asked = mount('desktop')
    await screen.findByRole('button', { name: /Search anything/ })
    let dialog = await open()
    const names = (await dialog.findAllByRole('option')).map((one) => one.textContent ?? '')
    expect(names.length).toBeGreaterThan(5)
    for (let index = 0; index < names.length; index++) {
      fireEvent.click((await dialog.findAllByRole('option'))[index]!)
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull())
      dialog = await open()
    }
    expect(asked.filter((one) => !one.startsWith('GET ') && one !== 'POST /api/viewing')).toEqual([])
  })
})
