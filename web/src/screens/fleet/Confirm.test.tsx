import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { answer } from '@/test/daemon'
import { renderInApp } from '@/test/inApp'
import { DeleteWorkspace, KillSession } from './Confirm'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function at(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    // xterm.js still asks for the legacy pair on the device-pixel-ratio query.
    addListener: () => {},
    removeListener: () => {},
  }))
}

describe('KillSession', () => {
  it('asks first, repeats the row, and sends the DELETE only on Kill', async () => {
    at(1440)
    const fetch = vi.fn(() => Promise.resolve(answer(200, { machine: 'macbook', session: 'landing', killed: true })))
    vi.stubGlobal('fetch', fetch)
    const onDone = vi.fn()
    await renderInApp(<KillSession machine="macbook" onDone={onDone} row={<p>landing · macbook · 3h 41m</p>} session="landing" />)

    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    const dialog = await screen.findByRole('dialog', { name: 'Kill landing?' })
    expect(dialog.textContent).toContain('landing · macbook · 3h 41m')
    expect(dialog.textContent).toContain('The tmux session on macbook and every process in it end now')
    expect(fetch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fetch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getAllByRole('button', { name: 'Kill' }).at(-1)!)
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(fetch).toHaveBeenCalledWith('/api/machines/macbook/sessions/landing', { method: 'DELETE' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it("draws the daemon's refusal inside the question", async () => {
    at(1440)
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(answer(403, 'node biswas-iphone is not yours'))))
    await renderInApp(<KillSession machine="macbook" session="landing" />)
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getAllByRole('button', { name: 'Kill' }).at(-1)!)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Kill was refused')
    expect(alert.textContent).toContain('node biswas-iphone is not yours')
  })

  it('is a bottom sheet on a phone', async () => {
    at(390)
    vi.stubGlobal('fetch', vi.fn())
    await renderInApp(<KillSession machine="macbook" session="landing" />)
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }))
    const sheet = await screen.findByRole('dialog', { name: 'Kill landing?' })
    expect(sheet.classList.contains('m3-bottom-sheet')).toBe(true)
    expect(sheet.textContent).toContain('end now. The agent gets no chance')
  })
})

describe('DeleteWorkspace', () => {
  it('offers Delete anyway on the 409 for a live session, and then sends force', async () => {
    at(1440)
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(answer(409, 'workspace landing has a live session'))
      .mockResolvedValueOnce(answer(204))
    vi.stubGlobal('fetch', fetch)
    const onDone = vi.fn()
    await renderInApp(<DeleteWorkspace name="landing" onDone={onDone} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByRole('dialog', { name: 'Delete landing?' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)
    const again = await screen.findByRole('button', { name: 'Delete anyway' })
    expect(fetch).toHaveBeenCalledWith('/api/workspaces/landing', { method: 'DELETE' })
    expect(screen.getByRole('alert').textContent).toContain('workspace landing has a live session')

    fireEvent.click(again)
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(fetch).toHaveBeenLastCalledWith('/api/workspaces/landing?force=true', { method: 'DELETE' })
  })

  it('sends force from the first ask when told to', async () => {
    at(1440)
    const fetch = vi.fn(() => Promise.resolve(answer(204)))
    vi.stubGlobal('fetch', fetch)
    await renderInApp(<DeleteWorkspace force name="landing" />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/workspaces/landing?force=true', { method: 'DELETE' }))
  })
})
