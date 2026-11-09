import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Effort } from '@/api/thread'
import { EffortPicker } from './EffortPicker'

describe('EffortPicker', () => {
  it("names the turn's effort, and lists Default and Claude's five levels", async () => {
    render(<EffortPicker onChange={() => {}} value="high" />)
    fireEvent.click(screen.getByRole('button', { name: 'Effort: High' }))
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((one) => one.getAttribute('aria-label'))).toEqual([
      'Default',
      'Low',
      'Medium',
      'High',
      'Extra High',
      'Max',
    ])
    expect(options[3].getAttribute('aria-checked')).toBe('true')
  })

  it('opens and picks with the keyboard alone', async () => {
    const onChange = vi.fn<(effort: Effort | null) => void>()
    render(<EffortPicker onChange={onChange} value={null} />)
    const trigger = screen.getByRole('button', { name: 'Effort: Default' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = await screen.findByRole('menu')
    const options = screen.getAllByRole('menuitemradio')
    await waitFor(() => expect(document.activeElement).toBe(options[0]))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(options[1]))
    fireEvent.keyDown(options[1], { key: 'Enter' })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('low'))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('cannot open while the chat is not connected', () => {
    render(<EffortPicker disabled onChange={() => {}} value="max" />)
    expect(screen.getByRole('button', { name: 'Effort: Max' })).toHaveProperty('disabled', true)
  })
})
