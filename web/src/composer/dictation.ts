/** Dictated words in place of the selection, with one space between them and
 *  any word they touch. Plain text: nothing in `piece` is read as markup. */
export function insertDictation(
  text: string,
  start: number,
  end: number,
  piece: string,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  const words = piece.trim()
  if (words === '') return { text, caret: to }
  const before = from > 0 && !/\s/.test(text[from - 1]) ? ' ' : ''
  const after = to < text.length && !/\s/.test(text[to]) ? ' ' : ''
  const inserted = `${before}${words}${after}`
  return { text: text.slice(0, from) + inserted + text.slice(to), caret: from + before.length + words.length }
}
