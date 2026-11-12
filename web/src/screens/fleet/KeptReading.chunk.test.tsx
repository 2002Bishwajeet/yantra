/**
 * The popover's chunk, in a file of its own: these tests count its load and need it to fail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderInApp } from '@/test/inApp'

const kept = { looked: 'ok', age_seconds: 372, retrying: 'GitHub answered 502', data: null } as const

/** The mark, loaded fresh, with the popover module the factory gives it. */
async function markWith(why: () => Record<string, unknown>) {
  vi.resetModules()
  vi.doMock('./KeptReadingWhy', why)
  return (await import('./KeptReading')).KeptReading
}

afterEach(() => cleanup())

describe('the popover of a kept reading', () => {
  it('keeps the mark when the chunk does not arrive, and a press says the reason could not be drawn', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fails = vi.fn(() => {
      throw new Error('Failed to fetch dynamically imported module')
    })
    const KeptReading = await markWith(fails)
    await renderInApp(<KeptReading reading={kept} />)
    const stamp = screen.getByRole('button', { name: 'as of 6m · retrying' })
    // The load that starts with the mark fails without a word. Vitest answers an import
    // made while a factory runs with the real module, so the press waits for that load.
    await waitFor(() => expect(fails).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(stamp)
    expect(await screen.findByText('The reason could not be drawn')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'as of 6m · retrying' })).toBe(stamp)
    quiet.mockRestore()
  })

  it('loads with the mark, and not with a fresh reading', async () => {
    const loads = vi.fn(() => ({ KeptReadingWhy: () => null }))
    const KeptReading = await markWith(loads)
    const page = await renderInApp(<KeptReading reading={{ looked: 'ok', age_seconds: 4, data: null }} />)
    await new Promise((done) => setTimeout(done, 50))
    expect(loads).not.toHaveBeenCalled()
    expect(screen.queryByRole('button')).toBeNull()
    page.unmount()

    await renderInApp(<KeptReading reading={kept} />)
    expect(screen.getByRole('button', { name: 'as of 6m · retrying' })).toBeTruthy()
    await waitFor(() => expect(loads).toHaveBeenCalledTimes(1))
  })
})
