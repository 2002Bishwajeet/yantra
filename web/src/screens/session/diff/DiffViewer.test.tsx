/**
 * The viewer with Pierre's two renderers stood in for: they draw into shadow
 * roots and Web Workers that jsdom has not got. The patch is parsed by the
 * real `@pierre/diffs`, the daemon's side is `contract.gen.ts`, and the
 * rendered result is checked in `e2e/diff.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Workspace } from '@/api'
import { threads } from '@/contract.gen'
import { answer } from '@/test/daemon'
import type { DiffData } from './data'
import DiffViewer from './DiffViewer'

type TreeOptions = {
  paths: string[]
  onSelectionChange: (paths: string[]) => void
  renderRowDecoration: (context: { item: { path: string } }) => { text: string; title: string } | null
}
type FileDiffProps = {
  fileDiff: { name: string }
  options: {
    enableGutterUtility: boolean
    enableLineSelection: boolean
    onGutterUtilityClick: (range: { start: number; end: number }) => void
    onLineSelectionEnd: (range: { start: number; end: number; side?: string } | null) => void
  }
  lineAnnotations: { side: string; lineNumber: number }[]
  renderAnnotation: (annotation: unknown) => React.ReactNode
  selectedLines: unknown
}

const tree = vi.hoisted(() => ({ options: undefined as unknown, selected: [] as string[], scrolled: [] as string[] }))

vi.mock('@pierre/trees/react', () => ({
  useFileTree: (options: TreeOptions) => {
    tree.options = options
    return {
      model: {
        resetPaths: () => {},
        setGitStatus: () => {},
        getSelectedPaths: () => tree.selected,
        scrollToPath: (path: string) => tree.scrolled.push(path),
        getItem: (path: string) =>
          options.paths.includes(path)
            ? { isDirectory: () => false, select: () => tree.selected.push(path), deselect: () => {} }
            : null,
      },
    }
  },
  FileTree: (props: { 'aria-label': string; onClickCapture?: (event: unknown) => void }) => {
    const options = tree.options as TreeOptions
    return (
      <ul aria-label={props['aria-label']} role="tree">
        {options.paths.map((path) => (
          <li
            aria-selected={tree.selected.includes(path)}
            data-decoration={options.renderRowDecoration({ item: { path } })?.text}
            key={path}
            onClick={() => options.onSelectionChange([path])}
            role="treeitem"
          >
            {path}
          </li>
        ))}
      </ul>
    )
  },
}))

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: (props: FileDiffProps) => (
    <div data-gutter={String(props.options.enableGutterUtility)} data-testid="file-diff">
      <span>{props.fileDiff.name}</span>
      <button onClick={() => props.options.onLineSelectionEnd({ start: 2, end: 3 })} type="button">
        select lines in {props.fileDiff.name}
      </button>
      <button onClick={() => props.options.onGutterUtilityClick({ start: 1, end: 1 })} type="button">
        plus on {props.fileDiff.name}
      </button>
      <button onClick={() => props.options.onLineSelectionEnd(null)} type="button">
        clear selection in {props.fileDiff.name}
      </button>
      {props.lineAnnotations.map((annotation, at) => (
        <div data-line={annotation.lineNumber} key={at}>
          {props.renderAnnotation(annotation)}
        </div>
      ))}
    </div>
  ),
}))

const web: Workspace = { name: 'site', machine: 'cachyos-g14', repo: '/r', startup: null }

const PATCH = [
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'index 0000000..e69de29',
  'Binary files /dev/null and b/logo.png differ',
  'diff --git a/src/old.rs b/src/new.rs',
  'similarity index 80%',
  'rename from src/old.rs',
  'rename to src/new.rs',
  'index 1..2 100644',
  '--- a/src/old.rs',
  '+++ b/src/new.rs',
  '@@ -1,2 +1,3 @@',
  ' a',
  '-b',
  '+c',
  '+d',
  'diff --git a/docs/deep/pure.md b/docs/pure.md',
  'similarity index 100%',
  'rename from docs/deep/pure.md',
  'rename to docs/pure.md',
  '',
].join('\n')

const branch: DiffData = {
  unified: PATCH,
  files: [
    { path: 'logo.png' },
    { path: 'src/new.rs', from: 'src/old.rs', added: 2, deleted: 1 },
    { path: 'docs/pure.md', from: 'docs/deep/pure.md', added: 0, deleted: 0 },
  ],
  truncated: false,
  filesTruncated: false,
}

const THREAD = '1a1b2c3d4e5f6a7b'
const asked = vi.fn()

function listing(status: number, body?: unknown) {
  asked.mockImplementation(() => Promise.resolve(answer(status, body)))
  vi.stubGlobal('fetch', asked)
}

function open(data: DiffData = branch, thread: string | null = THREAD) {
  const onComment = vi.fn<(block: string) => void>()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <DiffViewer data={data} onComment={onComment} thread={thread} workspace={web} />
    </QueryClientProvider>,
  )
  return onComment
}

beforeEach(() => {
  tree.selected = []
  tree.scrolled = []
  asked.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('the file tree', () => {
  it('is built from the daemon list, with rename, binary and counts on the rows', () => {
    listing(200, threads)
    open()
    const rows = within(screen.getByRole('tree', { name: 'Changed files' })).getAllByRole('treeitem')
    expect(rows.map((row) => [row.textContent, row.getAttribute('data-decoration')])).toEqual([
      ['logo.png', 'binary'],
      ['src/new.rs', 'renamed +2 −1'],
      ['docs/pure.md', 'renamed +0 −0'],
    ])
  })

  it('reveals a file in the code when its row is picked', async () => {
    listing(200, threads)
    const reveal = vi.fn()
    Element.prototype.scrollIntoView = reveal
    open()
    fireEvent.click(screen.getByRole('treeitem', { name: 'src/new.rs' }))
    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(1))
    expect(reveal.mock.instances[0]).toBe(document.querySelector('[data-path="src/new.rs"]')!.parentElement)
    expect(tree.scrolled).toContain('src/new.rs')
    expect(tree.selected).toContain('src/new.rs')
  })

  it('reads a turn’s list from the patch when the daemon sent none', () => {
    listing(200, threads)
    open({ unified: PATCH, truncated: false, filesTruncated: false })
    const rows = screen.getAllByRole('treeitem')
    expect(rows.map((row) => row.getAttribute('data-decoration'))).toEqual(['binary', 'renamed +2 −1', 'renamed +0 −0'])
  })
})

describe('each file', () => {
  it('draws code for a text file, and says so for a binary file and a pure rename', () => {
    listing(200, threads)
    open()
    expect(screen.getAllByTestId('file-diff').map((one) => one.textContent?.split('select')[0])).toEqual(['src/new.rs'])
    expect(screen.getByText('A binary file has no lines to show.')).toBeTruthy()
    expect(screen.getByText('Renamed with no change to its lines.')).toBeTruthy()
    expect(screen.getByText('renamed from src/old.rs')).toBeTruthy()
  })

  it('says a file was cut when the patch ends before it', () => {
    listing(200, threads)
    open({ ...branch, unified: '', files: [{ path: 'big.rs', added: 9, deleted: 0 }], truncated: true })
    expect(screen.getByText('The diff was cut before this file.')).toBeTruthy()
    expect(screen.getByText('Cut at 256 KiB')).toBeTruthy()
  })

  it('names the cut list, and an empty branch', () => {
    listing(200, threads)
    open({ ...branch, filesTruncated: true })
    expect(screen.getByText(/The list of files was cut/)).toBeTruthy()
    cleanup()
    open({ unified: '', files: [], truncated: false, filesTruncated: false })
    expect(screen.getByText('Nothing has changed on this branch.')).toBeTruthy()
  })
})

describe('a line comment', () => {
  const compose = () => screen.getByRole('textbox', { name: /^Comment on/ })

  it('opens on a selected range, takes focus, and hands the quoted block over on Cmd+Enter', async () => {
    listing(200, threads)
    const onComment = open()
    fireEvent.click(screen.getByRole('button', { name: 'select lines in src/new.rs' }))
    const box = await waitFor(compose)
    expect(box.getAttribute('aria-label')).toBe('Comment on src/new.rs L2-L3')
    await waitFor(() => expect(document.activeElement).toBe(box))
    // The selected range moves to the one open box: no second selection opens.
    expect(screen.getByTestId('file-diff').getAttribute('data-gutter')).toBe('false')

    fireEvent.change(box, { target: { value: ' rename these ' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    expect(onComment).toHaveBeenCalledWith('> src/new.rs:L2-L3\n> +c\n> +d\n\nrename these')
    expect(screen.queryByRole('textbox', { name: /^Comment on/ })).toBeNull()
    // Focus goes back to the file's heading.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /src\/new\.rs/ }))
  })

  it('opens from the gutter button, and submits with its button and Ctrl+Enter', async () => {
    listing(200, threads)
    const onComment = open()
    fireEvent.click(screen.getByRole('button', { name: 'plus on src/new.rs' }))
    const box = await waitFor(compose)
    const add = screen.getByRole('button', { name: 'Add to message' })
    expect(add.hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    expect(onComment).not.toHaveBeenCalled()
    fireEvent.change(box, { target: { value: 'why' } })
    fireEvent.click(add)
    expect(onComment).toHaveBeenCalledWith('> src/new.rs:L1\n>  a\n\nwhy')
  })

  it('cancels with Escape and with Cancel, sending nothing', async () => {
    listing(200, threads)
    const onComment = open()
    fireEvent.click(screen.getByRole('button', { name: 'plus on src/new.rs' }))
    fireEvent.keyDown(await waitFor(compose), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: /^Comment on/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'plus on src/new.rs' }))
    await waitFor(compose)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox', { name: /^Comment on/ })).toBeNull()
    expect(onComment).not.toHaveBeenCalled()
  })

  it('ignores a cleared selection', () => {
    listing(200, threads)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'clear selection in src/new.rs' }))
    expect(screen.queryByRole('textbox', { name: /^Comment on/ })).toBeNull()
  })

  it('comments on a whole file by a labelled button, for a keyboard and a screen reader', async () => {
    listing(200, threads)
    const onComment = open()
    fireEvent.click(screen.getByRole('button', { name: 'Comment on file: logo.png' }))
    const box = await waitFor(compose)
    expect(box.getAttribute('aria-label')).toBe('Comment on logo.png whole file')
    fireEvent.change(box, { target: { value: 'too big' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    expect(onComment).toHaveBeenCalledWith('> logo.png\n\ntoo big')
  })

  it('opens a whole-file box beside a file that has hunks, and keeps line comments alive after Cancel', async () => {
    listing(200, threads)
    const onComment = open()
    fireEvent.click(screen.getByRole('button', { name: 'Comment on file: src/new.rs' }))
    const box = await waitFor(compose)
    expect(box.getAttribute('aria-label')).toBe('Comment on src/new.rs whole file')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox', { name: /^Comment on/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'plus on src/new.rs' }))
    await waitFor(compose)
    expect(onComment).not.toHaveBeenCalled()
  })
})

describe('open in editor', () => {
  /** The menu is off until the thread list arrives; then it opens. */
  async function ready() {
    const name = 'Open in editor: src/new.rs'
    await waitFor(() => expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name }))
  }

  it('offers VS Code, Cursor and Zed for the thread’s worktree, with the first line where it counts', async () => {
    listing(200, threads)
    open()
    expect(asked.mock.calls[0]).toEqual(['/api/workspaces/site/threads', expect.objectContaining({ method: 'POST' })])
    const worktree = threads[1]!.worktree.slice(1).split('/').map(encodeURIComponent).join('/')
    await ready()
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => [item.textContent, item.getAttribute('href')])).toEqual([
      ['VS Code', `vscode://vscode-remote/ssh-remote+cachyos-g14/${worktree}/src/new.rs:1`],
      ['Cursor', `cursor://vscode-remote/ssh-remote+cachyos-g14/${worktree}/src/new.rs:1`],
      ['Zed', `zed://ssh/cachyos-g14/${worktree}/src/new.rs`],
    ])
  })

  it('puts the editor last used first, and remembers it', async () => {
    listing(200, threads)
    localStorage.setItem('yantra.editor', 'zed')
    open()
    await ready()
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Zed', 'VS Code', 'Cursor'])
    // The browser would follow the link; jsdom has no handler for `cursor:`.
    items[2]!.addEventListener('click', (event) => event.preventDefault())
    fireEvent.click(items[2]!)
    expect(localStorage.getItem('yantra.editor')).toBe('cursor')
  })

  it('threadsFailed: disables the menu, says why, and Try again reads the list again', async () => {
    listing(500, 'the grant is gone')
    open()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Files cannot open in an editor')
    expect(alert.textContent).toContain('the grant is gone')
    const off = screen.getByRole('button', { name: 'Open in editor: src/new.rs' })
    expect(off.hasAttribute('disabled')).toBe(true)
    expect(off.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(off.getAttribute('aria-describedby')!)?.textContent).toContain(
      'could not list this workspace’s threads',
    )

    listing(200, threads)
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByRole('button', { name: 'Open in editor: src/new.rs' }).hasAttribute('disabled')).toBe(false)
  })

  it('threadsFailed: when the list has no such thread', async () => {
    listing(200, threads)
    open(branch, 'ffffffffffffffff')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('this workspace lists no thread ffffffffffffffff')
  })

  it('threadsFailed: asks nothing when the chat has no thread', () => {
    listing(200, threads)
    open(branch, null)
    expect(asked).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('this chat has no thread yet')
  })

  it('waits quietly while the list is read', () => {
    asked.mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('fetch', asked)
    open()
    const off = screen.getByRole('button', { name: 'Open in editor: src/new.rs' })
    expect(off.hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
