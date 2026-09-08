import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { readPrefs } from '@/shell/prefs'
import { mountSettings, unmountSettings } from './harness'

afterEach(() => {
  cleanup()
  unmountSettings()
})

describe('General', () => {
  it('writes the clone home and the time format to this device', async () => {
    mountSettings('desktop', '/settings/general')
    fireEvent.click(await screen.findByRole('radio', { name: '~/Gitlab' }))
    expect(readPrefs().general.cloneHome).toBe('~/Gitlab')
    fireEvent.click(screen.getByRole('radio', { name: 'Clock' }))
    expect(readPrefs().general).toEqual({ cloneHome: '~/Gitlab', defaultMachine: null, time: 'clock' })
    expect(JSON.parse(localStorage.getItem('yantra.prefs')!).general.time).toBe('clock')
  })

  it('offers the machines the daemon lists as the default, and writes the one picked', async () => {
    mountSettings('desktop', '/settings/general')
    const select = await screen.findByRole('combobox', { name: 'Default machine for new sessions' })
    await screen.findByRole('option', { name: 'pi' })
    fireEvent.change(select, { target: { value: 'pi' } })
    expect(readPrefs().general.defaultMachine).toBe('pi')
    expect((select as HTMLSelectElement).value).toBe('pi')
  })

  it('says the rest is fixed, and that everything is saved on this device', async () => {
    mountSettings('desktop', '/settings/general')
    expect(await screen.findByText('fixed')).toBeTruthy()
    expect(screen.getByText('English')).toBeTruthy()
    expect(screen.getByText(/Saved on this device/)).toBeTruthy()
  })
})
