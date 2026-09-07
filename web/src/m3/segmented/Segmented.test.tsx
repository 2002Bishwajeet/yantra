import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Segment, Segmented } from './Segmented'

describe('Segmented', () => {
  it('is a named group of pressed buttons, one at a time', () => {
    const onValueChange = vi.fn()
    render(
      <Segmented label="Layout" defaultValue="clean" onValueChange={onValueChange}>
        <Segment value="clean">Clean</Segment>
        <Segment value="compact">Compact</Segment>
      </Segmented>,
    )
    expect(screen.getByRole('group', { name: 'Layout' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clean', pressed: true })).toBeTruthy()
    const compact = screen.getByRole('button', { name: 'Compact', pressed: false })
    fireEvent.click(compact)
    expect(onValueChange).toHaveBeenLastCalledWith('compact')
    expect(compact.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Clean' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('never lets the pressed one go unpressed', () => {
    const onValueChange = vi.fn()
    render(
      <Segmented label="Theme" value="light" onValueChange={onValueChange}>
        <Segment value="light">Light</Segment>
        <Segment value="dark">Dark</Segment>
      </Segmented>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Light' }))
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('keeps the pressed one pressed when uncontrolled, too', () => {
    const onValueChange = vi.fn()
    render(
      <Segmented label="Theme" defaultValue="light" onValueChange={onValueChange}>
        <Segment value="light">Light</Segment>
        <Segment value="dark">Dark</Segment>
      </Segmented>,
    )
    const light = screen.getByRole('button', { name: 'Light' })
    fireEvent.click(light)
    expect(light.getAttribute('aria-pressed')).toBe('true')
    expect(onValueChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }))
    expect(onValueChange).toHaveBeenLastCalledWith('dark')
    expect(light.getAttribute('aria-pressed')).toBe('false')
  })

  it('moves between segments with the arrow keys', async () => {
    render(
      <Segmented label="Theme" defaultValue="light">
        <Segment value="light">Light</Segment>
        <Segment value="dark">Dark</Segment>
      </Segmented>,
    )
    const light = screen.getByRole('button', { name: 'Light' })
    light.focus()
    fireEvent.keyDown(light, { key: 'ArrowRight' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dark' })))
  })
})
