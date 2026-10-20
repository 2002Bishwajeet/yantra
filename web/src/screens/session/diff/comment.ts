import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'

type Side = 'additions' | 'deletions'

/** The text of line `n` on one side, with its diff marker, or null where the
 *  patch does not hold it. Context lines sit in both arrays. */
function lineAt(file: FileDiffMetadata, side: Side, n: number): string | null {
  const lines = side === 'additions' ? file.additionLines : file.deletionLines
  for (const hunk of file.hunks) {
    const start = side === 'additions' ? hunk.additionStart : hunk.deletionStart
    const count = side === 'additions' ? hunk.additionCount : hunk.deletionCount
    const first = side === 'additions' ? hunk.additionLineIndex : hunk.deletionLineIndex
    if (n < start || n >= start + count) continue
    const at = first + (n - start)
    const text = lines[at]
    if (text === undefined) return null
    const changed = hunk.hunkContent.some((block) =>
      block.type !== 'change'
        ? false
        : side === 'additions'
          ? at >= block.additionLineIndex && at < block.additionLineIndex + block.additions
          : at >= block.deletionLineIndex && at < block.deletionLineIndex + block.deletions,
    )
    const marker = changed ? (side === 'additions' ? '+' : '-') : ' '
    return `${marker}${text.replace(/\r?\n$/, '')}`
  }
  return null
}

/** "L3" or "L3-L5", and the removed side's numbers are the old file's. */
export function rangeLabel(range: SelectedLineRange): string {
  const [lo, hi] = range.start <= range.end ? [range.start, range.end] : [range.end, range.start]
  const label = lo === hi ? `L${lo}` : `L${lo}-L${hi}`
  return (range.side ?? 'additions') === 'deletions' ? `${label} (removed)` : label
}

/** The lines a range selects, as the patch shows them. */
export function quotedLines(file: FileDiffMetadata, range: SelectedLineRange): string[] {
  const side = range.side ?? 'additions'
  const [lo, hi] = range.start <= range.end ? [range.start, range.end] : [range.end, range.start]
  const lines: string[] = []
  for (let n = lo; n <= hi; n += 1) {
    const text = lineAt(file, side, n)
    if (text !== null) lines.push(text)
  }
  return lines
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
