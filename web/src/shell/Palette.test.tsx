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

  /** 4.1.2: the cursor is `aria-activedescendant` on the field, so the options
   *  are not tab stops as well, and the keys the legend draws are named to a
   *  reader rather than hidden from one. */
  it('keeps one cursor, and says which keys move it', async () => {
    mount('desktop')
    await screen.findByRole('button', { name: /Search anything/ })
    const dialog = await open()
    for (const option of await dialog.findAllByRole('option')) {
      expect(option.getAttribute('tabindex')).toBe('-1')
    }
    const described = dialog.getByRole('combobox').getAttribute('aria-describedby')
    const legend = document.getElementById(described ?? '')
    expect(legend?.textContent).toContain('Up and down arrows move')
    expect(legend?.textContent).toContain('Enter open')
    expect(legend?.textContent).toContain('Esc close')
    expect(legend?.closest('[aria-hidden="true"]')).toBeNull()
  })

  /** Finding 122: the pane takes every key it is given, and Ctrl-K in it is
   *  readline's kill-to-end-of-line rather than a summons. */
  it('leaves Ctrl-K alone while the terminal pane holds focus', async () => {
    mount('desktop')
    await screen.findByRole('button', { name: /Search anything/ })
    const pane = document.createElement('div')
    pane.className = 'xterm'
    const keys = document.createElement('textarea')
    pane.append(keys)
    document.body.append(pane)
    keys.focus()
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull())
    keys.blur()
    pane.remove()
    expect(await open()).toBeTruthy()
  })

  it('lists machines and pages too', async () => {
    mount('desktop')
    await screen.findByRole('button', { name: /Search anything/ })
    const dialog = await open()
    expect(await dialog.findByRole('group', { name: 'Machines' })).toBeTruthy()
    expect(dialog.getByRole('group', { name: 'Pages' })).toBeTruthy()
    expect(dialog.getByText('Finds a place or a thread by its title, or runs a step of the coding loop.')).toBeTruthy()
  })

  /** D3 §3.2: every place the palette offers is opened, and the daemon is
   *  asked for nothing but readings. The loop's verbs are in Palette.loop.test.tsx. */
  it('runs no verb when it opens a place', async () => {
    const asked = mount('desktop')
    await screen.findByRole('button', { name: /Search anything/ })
    let dialog = await open()
    const places = (await dialog.findAllByRole('option')).filter((one) => !/^(Start from issue|Keyboard shortcuts)/.test(one.textContent ?? ''))
    expect(places.length).toBeGreaterThan(5)
    for (let index = 0; index < places.length; index++) {
      const found = await dialog.findAllByRole('option')
      fireEvent.click(found.filter((one) => !/^(Start from issue|Keyboard shortcuts)/.test(one.textContent ?? ''))[index]!)
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

  /** Y-689: a thread of an offline machine is found from the store, and picking it opens the chat. */
  describe('threads', () => {
    const found = [
      {
        workspace: 'site',
        machine: 'bishwajeets-macbook-pro',
        id: '5a1b',
        title: 'Keep a thread store',
        status: 'idle',
        seen: Date.now() - 180_000,
      },
    ]
    const at = (body: unknown, status = 200, q = 'store') => ({
      [`/api/threads?q=${q}`]: { status, body },
    })

    it('lists the thread, says the machine is offline and when it was seen, and opens it', async () => {
      mount('desktop', '/', { overrides: at(found) })
      await screen.findByRole('button', { name: /Search anything/ })
      const dialog = await open()
      fireEvent.change(dialog.getByRole('combobox'), { target: { value: 'store' } })
      const option = await dialog.findByRole('option', { name: /Keep a thread store/ })
      expect(dialog.getByRole('group', { name: 'Threads' })).toBeTruthy()
      expect(option.textContent).toMatch(/site · bishwajeets-macbook-pro · offline · seen 3m \d\ds ago/)
      fireEvent.keyDown(dialog.getByRole('combobox'), { key: 'Enter' })
      await waitFor(() => expect(location.pathname + location.search).toBe('/w/site?view=chat&thread=5a1b'))
    })

    it('opens the thread on a click', async () => {
      mount('desktop', '/', { overrides: at(found) })
      await screen.findByRole('button', { name: /Search anything/ })
      const dialog = await open()
      fireEvent.change(dialog.getByRole('combobox'), { target: { value: 'store' } })
      fireEvent.click(await dialog.findByRole('option', { name: /Keep a thread store/ }))
      await waitFor(() => expect(location.pathname + location.search).toBe('/w/site?view=chat&thread=5a1b'))
    })

    it('says a gone thread is gone', async () => {
      mount('desktop', '/', { overrides: at([{ ...found[0], status: 'gone' }]) })
      await screen.findByRole('button', { name: /Search anything/ })
      const dialog = await open()
      fireEvent.change(dialog.getByRole('combobox'), { target: { value: 'store' } })
      const option = await dialog.findByRole('option', { name: /Keep a thread store/ })
      expect(option.textContent).toContain('· gone')
    })

    it('names a failed read in the footer and keeps the other groups', async () => {
      mount('desktop', '/', { overrides: at('the daemon keeps no thread store', 503, 'sit') })
      await screen.findByRole('button', { name: /Search anything/ })
      const dialog = await open()
      fireEvent.change(dialog.getByRole('combobox'), { target: { value: 'sit' } })
      expect(await dialog.findByText(/Threads could not be read\./)).toBeTruthy()
      expect(dialog.getByRole('group', { name: 'Workspaces' })).toBeTruthy()
    })

    it('shows the empty state when nothing matches', async () => {
      mount('desktop', '/', { overrides: at([]) })
      await screen.findByRole('button', { name: /Search anything/ })
      const dialog = await open()
      fireEvent.change(dialog.getByRole('combobox'), { target: { value: 'store' } })
      expect(await dialog.findByText('Nothing matches')).toBeTruthy()
    })
  })
})
