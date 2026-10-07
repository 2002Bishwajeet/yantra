import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { mount, unmount } from './harness'
import type { FormFactor } from './formFactor'

vi.mock('./warm', () => ({}))

afterEach(() => {
  cleanup()
  unmount()
})

const drawn = async (size: FormFactor) => {
  mount(size)
  await screen.findAllByRole('heading', { level: 1, name: 'Dashboard' })
  return screen.findByRole('button', { name: 'Account' })
}
// user-event is not installed; this is the pointer sequence a real press sends.
const press = (el: HTMLElement) => {
  act(() => el.focus())
  fireEvent.pointerDown(el)
  fireEvent.mouseDown(el)
  fireEvent.pointerUp(el)
  fireEvent.mouseUp(el)
  fireEvent.click(el)
}
const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
const notBody = () => expect(document.activeElement).not.toBe(document.body)

describe.each<FormFactor>(['desktop', 'tablet', 'phone'])('the avatar trigger on %s', (size) => {
  it('stays one element through the first press, and focus never reaches the body', async () => {
    const trigger = await drawn(size)
    press(trigger)
    notBody()
    const menu = await screen.findByRole('menu')
    expect(screen.getByRole('button', { name: 'Account' })).toBe(trigger)
    await waitFor(() => expect(document.activeElement === trigger || menu.contains(document.activeElement)).toBe(true))
  })

  it('closes on Escape and gives the focus back to the same element', async () => {
    const trigger = await drawn(size)
    press(trigger)
    await screen.findByRole('menu')
    escape()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByRole('button', { name: 'Account' })).toBe(trigger)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('closes on a second press of the trigger and does not open again', async () => {
    const trigger = await drawn(size)
    press(trigger)
    await screen.findByRole('menu')
    press(trigger)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await new Promise((r) => setTimeout(r, 100))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('the desktop bell trigger', () => {
  const bell = async () => {
    await drawn('desktop')
    return screen.findByRole('button', { name: /Notifications/ })
  }

  it('stays one element through the first press, and focus never reaches the body', async () => {
    const trigger = await bell()
    press(trigger)
    notBody()
    const popover = await screen.findByRole('dialog', { name: 'Notifications' })
    expect(screen.getByRole('button', { name: /Notifications/ })).toBe(trigger)
    await waitFor(() => expect(document.activeElement === trigger || popover.contains(document.activeElement)).toBe(true))
  })

  it('closes on Escape and gives the focus back to the same element', async () => {
    const trigger = await bell()
    press(trigger)
    await screen.findByRole('dialog', { name: 'Notifications' })
    escape()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('closes on a second press of the trigger and does not open again', async () => {
    const trigger = await bell()
    press(trigger)
    await screen.findByRole('dialog', { name: 'Notifications' })
    press(trigger)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull())
    await new Promise((r) => setTimeout(r, 100))
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull()
  })
})
