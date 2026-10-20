/**
 * The viewer on Pierre's real diff renderer and real tree, in jsdom: a line
 * number is pressed, the comment box opens under it, and the block that comes
 * out quotes the lines the patch holds. `DiffViewer.test.tsx` stands both
 * renderers in for the cases that do not need them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Workspace } from '@/api'
import { chatBranchDiff, threads } from '@/contract.gen'
import { answer } from '@/test/daemon'
import DiffViewer from './DiffViewer'
import type { DiffData } from './data'
import { useEditors } from './useEditors'

const web: Workspace = { name: 'site', machine: 'cachyos-g14', repo: '/r', startup: null }

const PATCH = [
  'diff --git a/src/old.rs b/src/new.rs',
  'similarity index 80%',
  'rename from src/old.rs',
  'rename to src/new.rs',
  'index 1..2 100644',
  '--- a/src/old.rs',
  '+++ b/src/new.rs',
  '@@ -1,3 +1,4 @@',
  ' fn main() {',
  '-    old();',
  '+    new();',
  '+    more();',
  ' }',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'index 0000000..e69de29',
  'Binary files /dev/null and b/logo.png differ',
  '',
].join('\n')

const DATA: DiffData = { unified: PATCH, files: chatBranchDiff.files, truncated: false, filesTruncated: false }

function Viewer(props: { data: DiffData; onComment: (block: string) => void }) {
  const editors = useEditors(web.name, threads[1]!.id, true)
  return <DiffViewer data={props.data} editors={editors} onComment={props.onComment} workspace={web} />
}

class Quiet {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', Quiet)
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(answer(200, threads))))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const gutter = (type: string, n: number) =>
  waitFor(() => {
    const host = document.querySelector('[data-path="src/new.rs"] diffs-container')
    const cell = host?.shadowRoot?.querySelector(`[data-line-type="${type}"][data-column-number="${n}"]`)
    if (!cell) throw new Error('the line is not drawn yet')
    return cell
  })

describe('the viewer on the real renderers', () => {
  it('turns a pressed line number into a comment on that line, quoted from the patch', async () => {
    const onComment = vi.fn<(block: string) => void>()
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Viewer data={DATA} onComment={onComment} />
      </QueryClientProvider>,
    )
    const cell = await gutter('change-addition', 3)
    fireEvent.pointerDown(cell, { button: 0, pointerId: 1, isPrimary: true })
    fireEvent.pointerUp(cell, { button: 0, pointerId: 1, isPrimary: true })

    const box = await screen.findByRole('textbox', { name: 'Comment on src/new.rs L3' })
    await waitFor(() => expect(document.activeElement).toBe(box))
    fireEvent.change(box, { target: { value: 'name it' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    expect(onComment).toHaveBeenCalledWith('> src/new.rs:L3\n> +    more();\n\nname it')
    expect(screen.getByText('A binary file has no lines to show.')).toBeTruthy()
  })

  it('draws the tree’s rows with their words, and reveals the file a row names', async () => {
    const reveal = vi.fn()
    Element.prototype.scrollIntoView = reveal
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Viewer data={DATA} onComment={() => {}} />
      </QueryClientProvider>,
    )
    const rows = () => [...(document.querySelector('.diff__tree')?.shadowRoot?.querySelectorAll('[role="treeitem"]') ?? [])]
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(rows().map((row) => [row.getAttribute('aria-label'), row.querySelector('[data-item-section="decoration"]')?.textContent])).toEqual([
      ['src', ''],
      ['new.rs', 'renamed +3 −1'],
      ['logo.png', 'binary'],
    ])
    fireEvent.click(rows()[2]!)
    await waitFor(() => expect(reveal).toHaveBeenCalled())
    expect(reveal.mock.instances[0]).toBe(document.querySelector('[data-path="logo.png"]')!.parentElement)
  })
})
