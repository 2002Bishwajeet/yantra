import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MODES, type PermissionMode } from '@/api/thread'
import { ModePicker } from './ModePicker'

describe('ModePicker', () => {
  it("names the thread's mode, and lists T3 Code's four with their descriptions", async () => {
    render(<ModePicker onChange={() => {}} value="supervised" />)
    fireEvent.click(screen.getByRole('button', { name: 'Permissions: Supervised' }))
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((one) => one.getAttribute('aria-label'))).toEqual([
      'Supervised',
      'Auto-accept edits',
      'Auto',
      'Full access',
    ])
    options.forEach((one, at) => {
      const description = document.getElementById(one.getAttribute('aria-describedby') ?? '')
      expect(description?.textContent).toBe(MODES[at].description)
    })
    expect(options[0].getAttribute('aria-checked')).toBe('true')
  })

  it('opens and picks with the keyboard alone', async () => {
    const onChange = vi.fn<(mode: PermissionMode) => void>()
    render(<ModePicker onChange={onChange} value="supervised" />)
    const trigger = screen.getByRole('button', { name: 'Permissions: Supervised' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = await screen.findByRole('menu')
    const options = screen.getAllByRole('menuitemradio')
    await waitFor(() => expect(document.activeElement).toBe(options[0]))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(options[1]))
    fireEvent.keyDown(options[1], { key: 'Enter' })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('auto-accept-edits'))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('cannot open while the chat is not connected', () => {
    render(<ModePicker disabled onChange={() => {}} value="full-access" />)
    expect(screen.getByRole('button', { name: 'Permissions: Full access' })).toHaveProperty('disabled', true)
  })
})
