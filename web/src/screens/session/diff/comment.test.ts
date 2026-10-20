import { describe, expect, it } from 'vitest'
import { parsePatchFiles } from '@pierre/diffs'
import { appendToDraft, commentBlock, isSubmit, quotedLines, rangeLabel } from './comment'

const [file] = parsePatchFiles(
  [
    'diff --git a/s.rs b/s.rs',
    'index 1..2 100644',
    '--- a/s.rs',
    '+++ b/s.rs',
    '@@ -1,3 +1,4 @@',
    ' a',
    '-b',
    '+c',
    '+d',
    ' e',
    '',
  ].join('\n'),
).flatMap((patch) => patch.files)

describe('the quoted comment', () => {
  it('labels one line and a range, and marks the old file', () => {
    expect(rangeLabel({ start: 3, end: 3 })).toBe('L3')
    expect(rangeLabel({ start: 2, end: 4, side: 'additions' })).toBe('L2-L4')
    expect(rangeLabel({ start: 4, end: 2 })).toBe('L2-L4')
    expect(rangeLabel({ start: 2, end: 2, side: 'deletions' })).toBe('L2 (removed)')
  })

  it('quotes the lines a range selects with their diff markers', () => {
    expect(quotedLines(file!, { start: 1, end: 4 })).toEqual([' a', '+c', '+d', ' e'])
    expect(quotedLines(file!, { start: 1, end: 2, side: 'deletions' })).toEqual([' a', '-b'])
    expect(quotedLines(file!, { start: 40, end: 41 })).toEqual([])
  })

  it('writes the path, the lines, then the comment', () => {
    const range = { start: 2, end: 3 }
    expect(commentBlock('s.rs', range, quotedLines(file!, range), '  rename these ')).toBe(
      '> s.rs:L2-L3\n> +c\n> +d\n\nrename these',
    )
    expect(commentBlock('s.rs', null, [], 'whole file')).toBe('> s.rs\n\nwhole file')
  })

  it('appends after what was typed and leaves a fresh line for the caret', () => {
    expect(appendToDraft('', 'B')).toBe('B\n')
    expect(appendToDraft('look at this  \n', 'B')).toBe('look at this\n\nB\n')
    expect(appendToDraft(appendToDraft('', 'A'), 'B')).toBe('A\n\nB\n')
  })

  it('submits on Cmd or Ctrl with Enter, and never on a bare Enter', () => {
    expect(isSubmit({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(true)
    expect(isSubmit({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(true)
    expect(isSubmit({ key: 'Enter', metaKey: false, ctrlKey: false })).toBe(false)
    expect(isSubmit({ key: 'a', metaKey: true, ctrlKey: false })).toBe(false)
  })
})
