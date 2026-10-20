/**
 * The frame around the viewer: what it draws for a diff being asked for, for
 * each error kind, and for a chunk that does not load. The viewer itself is
 * `DiffViewer.test.tsx`'s.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import type { Workspace } from '@/api'
import { chatBranchDiff } from '@/contract.gen'
import { renderInApp } from '@/test/inApp'
import { branchData } from './data'
import { DiffSheet } from './DiffSheet'
import { DiffError, type DiffErrorKind } from './errors'

vi.mock('./DiffViewer', () => ({
  default: (props: { data: { unified: string } }) => (
    <p data-testid="viewer">{props.data.unified}</p>
  ),
}))

const editors = { worktree: '/w', trouble: null }
const web: Workspace = { name: 'site', machine: 'cachyos-g14', repo: '/r', startup: null }

afterEach(() => cleanup())

const TITLES: Record<DiffErrorKind, string> = {
  notOpen: 'The diff could not be asked for',
  noThread: 'There is no branch to compare yet',
  failed: 'The diff could not be read',
  busy: 'The diff waits for the revert',
  threadsFailed: 'Files cannot open in an editor',
  loadFailed: 'The diff viewer did not load',
}

describe('the diff frame', () => {
  it('says it is reading, to a screen reader and by bars', async () => {
    await renderInApp(<DiffSheet onComment={() => {}} state={{ state: 'loading' }} editors={editors} workspace={web} />)
    expect(screen.getByText('Reading the diff')).toBeTruthy()
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  for (const kind of Object.keys(TITLES) as DiffErrorKind[]) {
    it(`draws ${kind} as an ErrorSurface with its title and sentence`, async () => {
      const error = new DiffError(kind, kind === 'failed' ? 'fatal: bad object' : '')
      const retry = vi.fn()
      await renderInApp(
        <DiffSheet onComment={() => {}} onRetry={retry} state={{ state: 'failed', error }} editors={editors} workspace={web} />,
      )
      const alert = screen.getByRole('alert')
      expect(within(alert).getByRole('heading', { name: TITLES[kind] })).toBeTruthy()
      expect(alert.textContent).toContain(error.describe())
      expect(alert.textContent).toContain('on cachyos-g14')
      if (error.said) expect(alert.textContent).toContain(error.said)
      const again = within(alert).queryByRole('button', { name: 'Try again' })
      if (error.retryable) {
        fireEvent.click(again!)
        expect(retry).toHaveBeenCalledTimes(1)
      } else {
        expect(again).toBeNull()
      }
    })
  }

  it('hands a ready diff to the lazy viewer, with the thread', async () => {
    await renderInApp(
      <DiffSheet
        onComment={() => {}}
        state={{ state: 'ready', data: branchData(chatBranchDiff) }}
        editors={editors}
        workspace={web}
      />,
    )
    expect((await screen.findByTestId('viewer')).textContent).toBe(chatBranchDiff.unifiedDiff)
  })
})

