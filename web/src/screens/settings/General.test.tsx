import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { readPrefs } from '@/shell/prefs'
import { hideSetupCard } from '@/screens/dashboard/setupCard'
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

  /** D7 §4.9: a Finish setup card someone hid has a way back, and another
   *  row's write does not bring it back by accident. */
  it('offers a hidden setup card back, and keeps it hidden across other writes', async () => {
    mountSettings('desktop', '/settings/general')
    await screen.findByText('fixed')
    expect(screen.queryByRole('button', { name: 'Show the setup card' })).toBeNull()
    act(() => hideSetupCard())
    fireEvent.click(await screen.findByRole('radio', { name: 'Clock' }))
    expect(readPrefs().general.finishSetup).toBe('hidden')
    fireEvent.click(await screen.findByRole('button', { name: 'Show the setup card' }))
    expect(readPrefs().general.finishSetup).toBeUndefined()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show the setup card' })).toBeNull())
  })
})
