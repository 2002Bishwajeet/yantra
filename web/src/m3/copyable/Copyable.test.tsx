import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Copyable } from './Copyable'

const TEXT = 'curl -fsSL http://100.64.0.1:7717/join | sh'

const clipboard = (writeText: ((text: string) => Promise<void>) | undefined) =>
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  })

const hint = () => document.querySelector('.m3-copyable__hint')!

afterEach(() => {
  vi.restoreAllMocks()
  clipboard(undefined)
  window.getSelection()?.removeAllRanges()
  cleanup()
})

describe('Copyable', () => {
  it('says nothing before a copy, and the hint holds no text node', () => {
    render(<Copyable text={TEXT} what="the join command" />)
    expect(screen.getByText(TEXT)).toBeTruthy()
    expect(hint().childNodes).toHaveLength(0)
    expect(hint().getAttribute('aria-live')).toBe('polite')
  })

  it('copies where a clipboard exists', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    clipboard(writeText)
    render(<Copyable text={TEXT} what="the join command" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy the join command' }))
    expect(await screen.findByRole('button', { name: 'Copied the join command' })).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith(TEXT)
    expect(hint().childNodes).toHaveLength(0)
  })

  it('selects the text and says how to copy it where there is no clipboard', async () => {
    clipboard(undefined)
    render(<Copyable text={TEXT} what="the join command" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy the join command' }))
    expect(await screen.findByText(/no clipboard, so the text is selected/)).toBeTruthy()
    expect(window.getSelection()?.toString()).toBe(TEXT)
  })

  it('selects the text when the clipboard refuses the write', async () => {
    clipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    render(<Copyable text={TEXT} what="the join command" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy the join command' }))
    expect(await screen.findByText(/the text is selected/)).toBeTruthy()
    expect(window.getSelection()?.toString()).toBe(TEXT)
  })

  /** Only a selection that ran may be claimed. */
  it('asks the person to select it where the page cannot select either', async () => {
    clipboard(undefined)
    vi.spyOn(window, 'getSelection').mockReturnValue(null)
    render(<Copyable text={TEXT} what="the join command" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy the join command' }))
    expect(await screen.findByText('this page has no clipboard · select the text and copy it yourself')).toBeTruthy()
    expect(screen.queryByText(/the text is selected/)).toBeNull()
  })
})
