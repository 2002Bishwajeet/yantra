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

  /** 2.4.7: the list is 50 % of the window and scrolls, so an active option the
   *  arrow keys moved to has to come with them. */
  it('scrolls the option the arrow keys moved to into view', async () => {
    const scrolled: HTMLElement[] = []
    Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
      scrolled.push(this)
    }
    mount('desktop')
    await screen.findByRole('button', { name: /Search anything/ })
    const dialog = await open()
    const options = await dialog.findAllByRole('option')
    fireEvent.keyDown(dialog.getByRole('combobox'), { key: 'ArrowDown' })
    await waitFor(() => expect(options[1]!.getAttribute('aria-selected')).toBe('true'))
    expect(scrolled.at(-1)).toBe(options[1])
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
    // `logs` and `tokens` are reads a person asked for, POSTed by design
    // (ADR-0019); `viewing` is presence. None is a verb, and the e2e version
    // of this test excludes the same three (e2e/shell.spec.ts). The chat the
    // palette opens reads its own transcript, and under load that POST lands
    // late enough for this assertion to see it.
    const READS = /\/api\/viewing$|\/(logs|tokens)$/
    expect(asked.filter((one) => !one.startsWith('GET ') && !READS.test(one))).toEqual([])
  })
})
