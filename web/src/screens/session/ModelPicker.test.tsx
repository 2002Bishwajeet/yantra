import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ClaudeModel } from '@/api/thread'
import { ModelPicker } from './ModelPicker'

describe('ModelPicker', () => {
  it("names the turn's model, and lists Default and Claude's four aliases", async () => {
    render(<ModelPicker onChange={() => {}} value={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model: Default' }))
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((one) => one.getAttribute('aria-label'))).toEqual(['Default', 'Fable', 'Opus', 'Sonnet', 'Haiku'])
    expect(options[0].getAttribute('aria-checked')).toBe('true')
  })

  it('reports the model picked, and Default as no model', async () => {
    const onChange = vi.fn<(model: ClaudeModel | null) => void>()
    const { rerender } = render(<ModelPicker onChange={onChange} value={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model: Default' }))
    fireEvent.click((await screen.findAllByRole('menuitemradio'))[3])
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('sonnet'))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    rerender(<ModelPicker onChange={onChange} value="sonnet" />)
    fireEvent.click(screen.getByRole('button', { name: 'Model: Sonnet' }))
    fireEvent.click((await screen.findAllByRole('menuitemradio'))[0])
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null))
  })

  it('cannot open while the chat is not connected', () => {
    render(<ModelPicker disabled onChange={() => {}} value="opus" />)
    expect(screen.getByRole('button', { name: 'Model: Opus' })).toHaveProperty('disabled', true)
  })
})
