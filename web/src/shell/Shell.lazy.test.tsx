import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import type { FormFactor } from './formFactor'

const loaded = vi.hoisted(() => vi.fn<(name: string) => void>())

// The harness's warm-up would load all three before the shell is drawn.
vi.mock('./warm', () => ({}))
// Counted when the shell reads the export, because vitest runs a mock factory
// once per file and the shell's own `lazy()` reads it once per fresh module graph.
const spy = <T extends object>(name: string, key: string, mod: T) =>
  new Proxy(mod, {
    get(target, prop, receiver) {
      if (prop === key) loaded(name)
      return Reflect.get(target, prop, receiver)
    },
  })
vi.mock('./Account', async (orig) => spy('account', 'Account', await orig<object>()))
vi.mock('./BellPopover', async (orig) => spy('popover', 'BellPopover', await orig<object>()))
vi.mock('./Notifications', async (orig) => spy('list', 'NotificationsList', await orig<object>()))

let harness: typeof import('./harness')

beforeEach(async () => {
  loaded.mockClear()
  vi.resetModules()
  harness = await import('./harness')
})

afterEach(() => {
  cleanup()
  harness.unmount()
})

const drawn = async (size: FormFactor) => {
  harness.mount(size)
  await screen.findAllByRole('heading', { level: 1, name: 'Dashboard' })
  await screen.findByRole('button', { name: 'Account' })
}
const names = () => loaded.mock.calls.map(([name]) => name)

describe('the popups load with their first press', () => {
  it('loads the avatar menu on the click, not with the desktop shell', async () => {
    await drawn('desktop')
    expect(names()).not.toContain('account')
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(names()).toContain('account')
  })

  it('loads the bell popover on the click, not with the desktop shell', async () => {
    await drawn('desktop')
    expect(names()).not.toContain('popover')
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
    const popover = await screen.findByRole('dialog', { name: 'Notifications' })
    expect(await within(popover).findByText('api is waiting for trust')).toBeTruthy()
    expect(names()).toContain('popover')
  })

  it('keeps the avatar element, and opens nothing, when the pointer or focus reaches it', async () => {
    await drawn('desktop')
    const avatar = screen.getByRole('button', { name: 'Account' })
    fireEvent.pointerEnter(avatar)
    fireEvent.focus(avatar)
    expect(screen.getByRole('button', { name: 'Account' })).toBe(avatar)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(names()).not.toContain('account')
  })

  it('loads the sheet list on the first open of the tablet sheet, and the avatar on its click', async () => {
    await drawn('tablet')
    const sheet = document.getElementById('shell-notifications')!
    expect(sheet.hidden).toBe(true)
    expect(names()).toEqual([])
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
    expect(await within(sheet).findByText('api is waiting for trust')).toBeTruthy()
    expect(names()).toContain('list')
    expect(sheet.hidden).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    expect(await screen.findByRole('menu')).toBeTruthy()
  })

  it('loads the phone avatar on the click', async () => {
    await drawn('phone')
    expect(names()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(names()).toEqual(['account'])
  })
})
