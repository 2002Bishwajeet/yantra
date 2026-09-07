/** `git clone --progress` writes over one line with `\r` and ends a stage
 *  with `\n`, so the line a person would see is the text after the last of
 *  either. Escape sequences are stripped: the terminal drew them, the page
 *  draws a sentence. */
export function lastLine(previous: string, chunk: string): string {
  const text = (previous + chunk).replace(ESCAPES, '')
  const lines = text.split(/[\r\n]/).map((line) => line.trim())
  return lines.findLast((line) => line !== '') ?? ''
}

const ESCAPES = /\[[0-9;?]*[A-Za-z]|\][^]*/g
