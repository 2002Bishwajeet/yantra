import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CONTEXT_LENGTHS, lengthsFor, type ContextLength } from '@/api/thread'
import { ContextPicker } from './ContextPicker'

describe('ContextPicker', () => {
  it("names the thread's length, and lists Default and the four lengths", async () => {
    render(<ContextPicker lengths={CONTEXT_LENGTHS} onChange={() => {}} value={400_000} />)
    fireEvent.click(screen.getByRole('button', { name: 'Context: 400K' }))
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((one) => one.getAttribute('aria-label'))).toEqual(['Default', '256K', '400K', '512K', '1M'])
    expect(options[2].getAttribute('aria-checked')).toBe('true')
  })

  it('picks a length as a number, and Default as none', async () => {
    const onChange = vi.fn<(length: ContextLength | null) => void>()
    const { rerender } = render(<ContextPicker lengths={CONTEXT_LENGTHS} onChange={onChange} value={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Context: Default' }))
    fireEvent.click((await screen.findAllByRole('menuitemradio'))[4])
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(1_000_000))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    rerender(<ContextPicker lengths={CONTEXT_LENGTHS} onChange={onChange} value={1_000_000} />)
    fireEvent.click(screen.getByRole('button', { name: 'Context: 1M' }))
    fireEvent.click((await screen.findAllByRole('menuitemradio'))[0])
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null))
  })

  it('opens and picks with the keyboard alone', async () => {
    const onChange = vi.fn<(length: ContextLength | null) => void>()
    render(<ContextPicker lengths={CONTEXT_LENGTHS} onChange={onChange} value={null} />)
    const trigger = screen.getByRole('button', { name: 'Context: Default' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = await screen.findByRole('menu')
    const options = screen.getAllByRole('menuitemradio')
    await waitFor(() => expect(document.activeElement).toBe(options[0]))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(options[1]))
    fireEvent.keyDown(options[1], { key: 'Enter' })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(256_000))
  })

  it('cannot open while it is disabled', () => {
    render(<ContextPicker disabled lengths={CONTEXT_LENGTHS} onChange={() => {}} value={512_000} />)
    expect(screen.getByRole('button', { name: 'Context: 512K' })).toHaveProperty('disabled', true)
  })
})

describe('lengthsFor', () => {
  const labels = (lengths: readonly { label: string }[]) => lengths.map((one) => one.label)

  it("offers Claude's larger models every length, and Haiku only the default", () => {
    for (const model of [null, 'fable', 'opus', 'sonnet'] as const) {
      expect(labels(lengthsFor('claude', model))).toEqual(['Default', '256K', '400K', '512K', '1M'])
    }
    expect(labels(lengthsFor('claude', 'haiku'))).toEqual(['Default'])
  })

  it('offers Codex no more than the window it last reported', () => {
    expect(labels(lengthsFor('codex', null))).toEqual(['Default', '256K', '400K', '512K', '1M'])
    expect(labels(lengthsFor('codex', null, 400_000))).toEqual(['Default', '256K', '400K'])
  })

  it('offers the harnesses that take no length nothing', () => {
    for (const harness of ['gemini', 'grok', 'opencode', null] as const) expect(lengthsFor(harness, null)).toEqual([])
  })
})
