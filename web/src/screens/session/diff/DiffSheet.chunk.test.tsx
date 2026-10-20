/**
 * The viewer's chunk, in a file of its own: a mocked module is mocked for the
 * whole file, and these tests need it to fail and to throw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { Workspace } from '@/api'
import { chatBranchDiff } from '@/contract.gen'
import { renderInApp } from '@/test/inApp'
import { branchData } from './data'
import { DiffError } from './errors'

const web: Workspace = { name: 'site', machine: 'cachyos-g14', repo: '/r', startup: null }

/** The frame, loaded fresh, with the viewer module the factory gives it. */
async function frameWith(viewer: () => Record<string, unknown>) {
  vi.resetModules()
  vi.doMock('./DiffViewer', viewer)
  return (await import('./DiffSheet')).DiffSheet
}

afterEach(() => cleanup())

const editors = { worktree: '/w', trouble: null }
const ready = { state: 'ready' as const, data: branchData(chatBranchDiff) }

describe('a viewer chunk that does not arrive', () => {
  it('draws loadFailed with the import’s own words, and Try again loads it afresh', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    let attempts = 0
    const Sheet = await frameWith(() => {
      attempts += 1
      if (attempts === 1) throw new Error('Failed to fetch dynamically imported module')
      return { default: () => <p data-testid="viewer">arrived</p> }
    })
    await renderInApp(<Sheet onComment={() => {}} state={ready} editors={editors} workspace={web} />)
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The diff viewer did not load' })).toBeTruthy()
    expect(alert.textContent).toContain(new DiffError('loadFailed').describe())
    expect(screen.queryByTestId('viewer')).toBeNull()

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect((await screen.findByTestId('viewer')).textContent).toBe('arrived')
    quiet.mockRestore()
  })
})

describe('a viewer that throws while it draws', () => {
  it('is caught by the boundary and drawn as an error, not a blank panel or a load failure', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Sheet = await frameWith(() => ({
      default: () => {
        throw new Error('boom')
      },
    }))
    await renderInApp(<Sheet onComment={() => {}} state={ready} editors={editors} workspace={web} />)
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'The diff could not be drawn' })).toBeTruthy()
    await waitFor(() => expect(alert.textContent).toContain('Something in this part of the page broke.'))
    expect(alert.textContent).not.toContain('The diff viewer did not load')
    quiet.mockRestore()
  })
})
