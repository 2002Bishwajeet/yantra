import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'

type Side = 'additions' | 'deletions'

/** One row of the unified view, in the order it is drawn: a removed line has an old
 *  number, an added line a new one, and a context line both. */
type Row = { del?: number; add?: number; text: string }

function rowsOf(file: FileDiffMetadata): Row[] {
  const rows: Row[] = []
  for (const hunk of file.hunks) {
    let del = hunk.deletionStart
    let add = hunk.additionStart
    for (const block of hunk.hunkContent) {
      if (block.type === 'context') {
        for (let i = 0; i < block.lines; i += 1) {
          rows.push({ del: del++, add: add++, text: ` ${strip(file.additionLines[block.additionLineIndex + i])}` })
        }
        continue
      }
      for (let i = 0; i < block.deletions; i += 1) {
        rows.push({ del: del++, text: `-${strip(file.deletionLines[block.deletionLineIndex + i])}` })
      }
      for (let i = 0; i < block.additions; i += 1) {
        rows.push({ add: add++, text: `+${strip(file.additionLines[block.additionLineIndex + i])}` })
      }
    }
  }
  return rows
}

const strip = (line: string | undefined) => (line ?? '').replace(/\r?\n$/, '')
const numberOn = (row: Row, side: Side) => (side === 'additions' ? row.add : row.del)
const indexOf = (rows: Row[], side: Side, n: number) => rows.findIndex((row) => numberOn(row, side) === n)

const point = (n: number, side: Side) => (side === 'deletions' ? `L${n} (removed)` : `L${n}`)

/** "L3" or "L3-L5", and the removed side's numbers are the old file's. */
export function rangeLabel(range: SelectedLineRange): string {
  const side = range.side ?? 'additions'
  const endSide = range.endSide ?? side
  if (endSide !== side) return `${point(range.start, side)}-${point(range.end, endSide)}`
  const [lo, hi] = range.start <= range.end ? [range.start, range.end] : [range.end, range.start]
  const label = lo === hi ? `L${lo}` : `L${lo}-L${hi}`
  return side === 'deletions' ? `${label} (removed)` : label
}

/** The lines a range selects, as the patch shows them. A range from a removed line to
 *  an added one runs through every row drawn between the two. */
export function quotedLines(file: FileDiffMetadata, range: SelectedLineRange): string[] {
  const side = range.side ?? 'additions'
  const endSide = range.endSide ?? side
  const rows = rowsOf(file)
  if (endSide !== side) {
    const from = indexOf(rows, side, range.start)
    const to = indexOf(rows, endSide, range.end)
    if (from < 0 || to < 0) return []
    return rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.text)
  }
  const [lo, hi] = range.start <= range.end ? [range.start, range.end] : [range.end, range.start]
  return rows.filter((row) => (numberOn(row, side) ?? -1) >= lo && (numberOn(row, side) ?? -1) <= hi).map((row) => row.text)
}

/** The line the comment box sits under: the last one drawn of the two ends. */
export function anchorOf(file: FileDiffMetadata, range: SelectedLineRange): { side: Side; lineNumber: number } {
  const side = range.side ?? 'additions'
  const endSide = range.endSide ?? side
  if (endSide === side) return { side, lineNumber: Math.max(range.start, range.end) }
  const rows = rowsOf(file)
  const later = indexOf(rows, side, range.start) > indexOf(rows, endSide, range.end)
  return later ? { side, lineNumber: range.start } : { side: endSide, lineNumber: range.end }
}

/** A markdown quote the agent reads: where, which lines, then the comment.
 *  No range is a comment on the whole file. */
export function commentBlock(
  path: string,
  range: SelectedLineRange | null,
  lines: readonly string[],
  text: string,
): string {
  const where = range === null ? path : `${path}:${rangeLabel(range)}`
  const quote = [where, ...lines].map((line) => `> ${line}`).join('\n')
  return `${quote}\n\n${text.trim()}`
}

/** The block goes after what the person already typed, and the caret has a
 *  fresh line to continue on. Nothing is sent. */
export function appendToDraft(draft: string, block: string): string {
  const before = draft.trimEnd()
  return `${before === '' ? '' : `${before}\n\n`}${block}\n`
}

/** ⌘ or Ctrl with Enter sends a comment; a bare Enter is a new line. */
export function isSubmit(event: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey)
}
