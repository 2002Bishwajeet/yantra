/** M16 (Y-499): the palette lists the loop's verbs, and a verb opens its own dialog. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useLoopChords, useRegisterLoopCommands } from './loopCommands'
import { KEYS } from '@/screens/session/keys'
import { mount, unmount } from './harness'

afterEach(() => {
  cleanup()
  unmount()
})

const merge = vi.fn()

/** Stands for the Chat: it registers the verbs the way GitActions and the header do. */
function Chat(props: { off?: boolean }) {
  useLoopChords()
  useRegisterLoopCommands(
    [
      { id: 'diff', disabled: false, reason: null },
      { id: 'commit', disabled: false, reason: null },
      { id: 'push', disabled: false, reason: null },
      { id: 'pr', disabled: false, reason: null },
      { id: 'merge', disabled: !!props.off, reason: props.off ? 'There is no open PR to merge.' : null },
    ],
    (id) => {
      if (id === 'merge') merge()
    },
  )
  return null
}

async function search(text = '') {
  await screen.findByRole('button', { name: /Search anything/ })
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  const dialog = within(await screen.findByRole('dialog', { name: 'Search' }))
  if (text) fireEvent.change(dialog.getByRole('combobox'), { target: { value: text } })
  return dialog
}

describe('the palette and the loop', () => {
  it('lists the six commands first, with their chords, while a chat is mounted', async () => {
    mount('desktop')
    render(<Chat />)
    const dialog = await search()
    const group = within(await dialog.findByRole('group', { name: 'Commands' }))
    for (const name of ['Start from issue', 'Diff', 'Commit', 'Push', 'Open PR', 'Merge']) {
      expect(group.getByRole('option', { name: new RegExp(`^${name}`) })).toBeTruthy()
    }
    expect(group.getAllByRole('option')).toHaveLength(6)
    expect(group.getByRole('option', { name: /^Diff/ }).textContent).toContain(KEYS.find((one) => one.id === 'diff')!.display)
    expect(dialog.getAllByRole('group')[0]!.getAttribute('aria-label')).toBe('Commands')
  })

  it('shows only Start from issue where no chat is mounted', async () => {
    mount('desktop')
    const dialog = await search()
    const group = within(await dialog.findByRole('group', { name: 'Commands' }))
    expect(group.getAllByRole('option')).toHaveLength(1)
    expect(dialog.queryByRole('option', { name: /^Merge/ })).toBeNull()
  })

  it('shows a disabled verb with its reason, and Enter does nothing', async () => {
    mount('desktop')
    render(<Chat off />)
    const dialog = await search('merge')
    const option = await dialog.findByRole('option', { name: /^Merge/ })
    expect(option.getAttribute('aria-disabled')).toBe('true')
    expect(option.textContent).toContain('There is no open PR to merge.')
    fireEvent.keyDown(dialog.getByRole('combobox'), { key: 'Enter' })
    await new Promise((done) => setTimeout(done, 50))
    expect(merge).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeTruthy()
  })

  it('Enter on Merge closes the palette, then runs the verb', async () => {
    merge.mockClear()
    mount('desktop')
    render(<Chat />)
    const dialog = await search('merge')
    await dialog.findByRole('option', { name: /^Merge/ })
    fireEvent.keyDown(dialog.getByRole('combobox'), { key: 'Enter' })
    await waitFor(() => expect(merge).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull())
  })

  it('Start from issue opens the picker for the chosen issue', async () => {
    mount('desktop')
    const dialog = await search('issue')
    const option = await dialog.findByRole('option', { name: /^Start from issue/ })
    expect(option.textContent).toContain('2002Bishwajeet/yantra#118')
    fireEvent.keyDown(dialog.getByRole('combobox'), { key: 'Enter' })
    const picker = await screen.findByRole('dialog', { name: 'Start a session on 2002Bishwajeet/yantra#118' })
    // Under control the picker draws no trigger of its own.
    expect(screen.queryByRole('button', { name: /^Start session on/ })).toBeNull()
    fireEvent.click(within(picker).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('the issue chord opens the palette with the issue rows', async () => {
    mount('desktop')
    render(<Chat />)
    await screen.findByRole('button', { name: /Search anything/ })
    const issue = KEYS.find((one) => one.id === 'issue')!
    fireEvent.keyDown(document, { code: issue.code, altKey: true, ctrlKey: true })
    const dialog = within(await screen.findByRole('dialog', { name: 'Search' }))
    expect((dialog.getByRole('combobox') as HTMLInputElement).value).toBe('Start from issue')
    expect(await dialog.findByRole('option', { name: /^Start from issue/ })).toBeTruthy()
  })
})

describe('the ? sheet', () => {
  it('opens on ?, lists every chord and ⌘K, and closes', async () => {
    mount('desktop')
    await screen.findByRole('button', { name: /Search anything/ })
    fireEvent.keyDown(document, { key: '?' })
    const sheet = within(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' }))
    expect(sheet.getAllByRole('term').map((one) => one.textContent)).toEqual([
      'Search',
      'Keyboard shortcuts',
      ...KEYS.map((one) => one.label),
    ])
    fireEvent.click(sheet.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('does not open while a text field has the focus', async () => {
    mount('desktop')
    const dialog = await search()
    dialog.getByRole('combobox').focus()
    fireEvent.keyDown(dialog.getByRole('combobox'), { key: '?' })
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull()
  })

  it('has a palette entry, for a screen with no keyboard', async () => {
    mount('desktop')
    const dialog = await search('keyboard')
    fireEvent.keyDown(dialog.getByRole('combobox'), { key: 'Enter' })
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy()
  })

  it('is a bottom sheet on the phone, and ? works there too', async () => {
    mount('phone')
    await screen.findByRole('navigation', { name: 'Main' })
    fireEvent.keyDown(document, { key: '?' })
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(sheet.className).toContain('m3-bottom-sheet')
  })
})
