import { describe, expect, it } from 'vitest'
import { parsePatchFiles } from '@pierre/diffs'
import { chatBranchDiff } from '@/contract.gen'
import { ancestors, decoration, filesOfPatch, treeEntries } from './tree'

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

const parsed = () => parsePatchFiles(PATCH).flatMap((patch) => patch.files)

describe('the file tree rows', () => {
  it('reads a rename, a binary file and counts from the daemon list', () => {
    expect(treeEntries(chatBranchDiff.files)).toEqual([
      { path: 'src/new.rs', from: 'src/old.rs', added: 3, deleted: 1, binary: false, status: 'renamed' },
      { path: 'logo.png', binary: true, status: 'modified' },
    ])
  })

  it('takes added and deleted from the patch, because the list cannot tell them', () => {
    const types = new Map(parsed().map((file) => [file.name, file.type]))
    const rows = treeEntries([{ path: 'logo.png' }, { path: 'gone.rs', added: 0, deleted: 4 }], new Map([...types, ['gone.rs', 'deleted']]))
    expect(rows.map((row) => row.status)).toEqual(['added', 'deleted'])
  })

  it('words a row: counts, binary, and renamed first', () => {
    const [renamed, binary] = treeEntries(chatBranchDiff.files)
    expect(decoration(renamed!)).toEqual({ text: 'renamed +3 −1', title: 'Renamed from src/old.rs. +3 −1' })
    expect(decoration(binary!)).toEqual({ text: 'binary', title: 'binary' })
    expect(decoration({ path: 'a', added: 0, deleted: 2, binary: false, status: 'modified' }).text).toBe('+0 −2')
  })

  it('lists the folders above a nested path, shallowest first', () => {
    expect(ancestors('a/b/c.ts')).toEqual(['a/', 'a/b/'])
    expect(ancestors('c.ts')).toEqual([])
  })

  it("builds a turn's list from the patch: binary has no counts, a pure rename has zero", () => {
    expect(filesOfPatch(parsed())).toEqual([
      { path: 'logo.png' },
      { path: 'src/new.rs', from: 'src/old.rs', added: 2, deleted: 1 },
      { path: 'docs/pure.md', from: 'docs/deep/pure.md', added: 0, deleted: 0 },
    ])
  })

  it('keeps a nested directory structure in the paths it hands the tree', () => {
    const rows = treeEntries([{ path: 'a/b/c.ts', added: 1, deleted: 0 }, { path: 'a/d.ts', added: 1, deleted: 0 }])
    expect(rows.map((row) => row.path)).toEqual(['a/b/c.ts', 'a/d.ts'])
    expect(rows.flatMap((row) => ancestors(row.path))).toEqual(['a/', 'a/b/', 'a/'])
  })
})
