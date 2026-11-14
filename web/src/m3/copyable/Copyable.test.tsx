import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Copyable } from './Copyable'

const TEXT = 'curl -fsSL http://100.64.0.1:7717/join | sh'
/** Y-779: ESC[201~ ends a bracketed paste early, and the CR runs what follows. */
const HIDDEN = "sudo apt update\u001b[201~\rsudo sh -c 'x'\r"
const CONTROL = /[^\P{Cc}\t\n]/u

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
  it('scrolls a long command sideways on a line, and wraps it otherwise (Y-733)', () => {
    const { rerender } = render(<Copyable text={TEXT} what="the join command" />)
    expect(screen.getByText(TEXT).classList.contains('m3-copyable__text--line')).toBe(false)
    rerender(<Copyable line text={TEXT} what="the join command" />)
    expect(screen.getByText(TEXT).classList.contains('m3-copyable__text--line')).toBe(true)
  })

  it('draws a text Copy, and a filled one for a hero', () => {
    const { rerender } = render(<Copyable text={TEXT} what="the join command" />)
    expect(screen.getByRole('button', { name: 'Copy the join command' }).getAttribute('data-variant')).toBe('text')
    rerender(<Copyable hero text={TEXT} what="the join command" />)
    expect(screen.getByRole('button', { name: 'Copy the join command' }).getAttribute('data-variant')).toBe('filled')
  })

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

  it('forgets a copy when the text changes, so a new code never reads Copied', async () => {
    clipboard(vi.fn(() => Promise.resolve()))
    const { rerender } = render(<Copyable text="AAAA-1111" what="the code" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy the code' }))
    expect(await screen.findByRole('button', { name: 'Copied the code' })).toBeTruthy()
    rerender(<Copyable text="BBBB-2222" what="the code" />)
    expect(screen.getByRole('button', { name: 'Copy the code' })).toBeTruthy()
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

  it('puts no control character on the clipboard (Y-779)', async () => {
    const writeText = vi.fn((_: string) => Promise.resolve())
    clipboard(writeText)
    render(<Copyable text={HIDDEN} what="the command" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy the command' }))
    expect(await screen.findByRole('button', { name: 'Copied the command' })).toBeTruthy()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).not.toMatch(CONTROL)
    expect(writeText.mock.calls[0][0]).toBe("sudo apt update[201~sudo sh -c 'x'")
  })

  it('selects no control character where there is no clipboard (Y-779)', async () => {
    clipboard(undefined)
    render(<Copyable text={HIDDEN} what="the command" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy the command' }))
    expect(await screen.findByText(/the text is selected/)).toBeTruthy()
    expect(window.getSelection()?.toString()).not.toMatch(CONTROL)
    expect(window.getSelection()?.toString()).toBe("sudo apt update[201~sudo sh -c 'x'")
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
