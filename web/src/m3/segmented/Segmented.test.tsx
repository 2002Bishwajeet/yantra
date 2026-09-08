import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Segment, Segmented } from './Segmented'

describe('Segmented', () => {
  it('is a named radio group with one segment checked at a time', () => {
    const onValueChange = vi.fn()
    render(
      <Segmented label="Layout" defaultValue="clean" onValueChange={onValueChange}>
        <Segment value="clean">Clean</Segment>
        <Segment value="compact">Compact</Segment>
      </Segmented>,
    )
    expect(screen.getByRole('radiogroup', { name: 'Layout' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Clean', checked: true })).toBeTruthy()
    const compact = screen.getByRole('radio', { name: 'Compact', checked: false })
    fireEvent.click(compact)
    expect(onValueChange).toHaveBeenLastCalledWith('compact')
    expect(compact.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Clean' }).getAttribute('aria-checked')).toBe('false')
  })

  it('never lets the checked one go unchecked', () => {
    const onValueChange = vi.fn()
    render(
      <Segmented label="Theme" value="light" onValueChange={onValueChange}>
        <Segment value="light">Light</Segment>
        <Segment value="dark">Dark</Segment>
      </Segmented>,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true')
  })

  it('keeps the checked one checked when uncontrolled, too', () => {
    const onValueChange = vi.fn()
    render(
      <Segmented label="Theme" defaultValue="light" onValueChange={onValueChange}>
        <Segment value="light">Light</Segment>
        <Segment value="dark">Dark</Segment>
      </Segmented>,
    )
    const light = screen.getByRole('radio', { name: 'Light' })
    fireEvent.click(light)
    expect(light.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(onValueChange).toHaveBeenLastCalledWith('dark')
    expect(light.getAttribute('aria-checked')).toBe('false')
  })

  it('moves between segments with the arrow keys', async () => {
    render(
      <Segmented label="Theme" defaultValue="light">
        <Segment value="light">Light</Segment>
        <Segment value="dark">Dark</Segment>
      </Segmented>,
    )
    const light = screen.getByRole('radio', { name: 'Light' })
    light.focus()
    fireEvent.keyDown(light, { key: 'ArrowRight' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Dark' })))
  })
})
